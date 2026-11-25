// Renovación y cobranza (C4): cobro automático con la tarjeta guardada, 3DS por correo, reintentos,
// pendientes que se cancelan y avisos por correo una sola vez. ONVO y Resend simulados.
import { jest } from "@jest/globals"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { processBilling } from "./renewals.service.ts"

const DAY = 24 * 60 * 60 * 1000
const inDays = (d: number) => new Date(Date.now() + d * DAY)

type Call = { method: string; url: string; body: Record<string, unknown> | null }
let calls: Call[] = []
let confirmAs: "ok" | "3ds" | "declined" = "ok"
let intentOnGet = "succeeded"
let n = 0
const emails = () => calls.filter((c) => c.url.startsWith("https://api.resend.com")).map((c) => c.body as { to: string; subject: string; html: string })

beforeEach(async () => {
  await resetDb()
  calls = []
  confirmAs = "ok"
  intentOnGet = "succeeded"
  process.env.BILLING_ENABLED = "1"
  process.env.ONVO_SECRET_KEY = "onvo_test_secret_key_x"
  process.env.ONVO_PUBLISHABLE_KEY = "onvo_test_publishable_key_x"
  process.env.RESEND_API_KEY = "re_prueba"
  process.env.EMAIL_FROM = "Cubivo <facturas@cubivo.org>"
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ method, url, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (url.startsWith("https://api.resend.com")) return json({ id: "mail" })
    if (method === "POST" && url.endsWith("/v1/payment-intents")) return json({ id: `pi_${++n}`, status: "requires_payment_method" }, 201)
    if (url.endsWith("/cancel")) return json({ id: url.split("/").at(-2), status: "canceled" }, 201)
    if (url.endsWith("/confirm")) {
      const id = url.split("/").at(-2)
      if (confirmAs === "ok") return json({ id, status: "succeeded" }, 201)
      if (confirmAs === "3ds") return json({ id, status: "requires_action", nextAction: { redirectToUrl: { url: "https://checkout.onvopay.com/authorize/test_y" } } }, 201)
      return json({ id, status: "requires_payment_method", lastPaymentError: { message: "Fondos insuficientes" } }, 201)
    }
    if (url.includes("/v1/payment-intents/")) return json({ id: url.split("/").at(-1), status: intentOnGet })
    return json({ message: "no simulado" }, 404)
  })
})
afterEach(() => {
  jest.restoreAllMocks()
  for (const k of ["BILLING_ENABLED", "ONVO_SECRET_KEY", "ONVO_PUBLISHABLE_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) delete process.env[k]
})
afterAll(async () => {
  await resetDb()
})

// cuenta pagada hasta `paidUntil`, con tarjeta guardada
async function paidOwner(paidUntil: Date, withCard = true) {
  const admin = await createUser("ADMIN")
  const sub = await prisma.subscription.create({
    data: {
      userId: admin.user.id, trialEndsAt: new Date(Date.now() - 40 * DAY), paidUntil,
      ...(withCard && { onvoCustomerId: "cus_1", paymentMethodId: "pm_1", cardBrand: "Visa", cardLast4: "4242" }),
    },
  })
  return { admin, sub }
}
const subOf = (id: string) => prisma.subscription.findUniqueOrThrow({ where: { id } })

it("apagado (sin BILLING_ENABLED) no hace nada", async () => {
  delete process.env.BILLING_ENABLED
  await paidOwner(new Date(Date.now() - DAY))
  await processBilling()
  expect(calls).toHaveLength(0)
})

it("al vencer cobra solo a la tarjeta guardada y sigue sin cortes desde el vencimiento", async () => {
  const due = new Date(Date.now() + 2 * 60 * 60 * 1000) // vence en 2 horas
  const { admin, sub } = await paidOwner(due)
  await processBilling()
  const confirm = calls.find((c) => c.url.endsWith("/confirm"))!
  expect(confirm.body).toMatchObject({ paymentMethodId: "pm_1" })
  const after = await subOf(sub.id)
  // el nuevo mes empieza donde terminaba el pagado
  expect(after.paidUntil!.getTime()).toBeGreaterThan(due.getTime() + 27 * DAY)
  const payment = await prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } })
  expect(payment).toMatchObject({ status: "SUCCEEDED", automatic: true, amount: 14900 })
  expect(emails().map((e) => e.subject)).toEqual([expect.stringMatching(/^Pago recibido: ₡14\s900/u)])
  expect(emails()[0]!.to).toBe(admin.user.email)
  // otra vuelta no vuelve a cobrar
  await processBilling()
  expect(calls.filter((c) => c.url.endsWith("/confirm"))).toHaveLength(1)
})

it("si el banco pide 3DS le manda el enlace por correo, y al confirmarse se aplica en la siguiente vuelta", async () => {
  const { sub } = await paidOwner(new Date(Date.now() + HOURS(1)))
  confirmAs = "3ds"
  await processBilling()
  expect(emails()).toHaveLength(1)
  expect(emails()[0]!.subject).toMatch(/Confirma el cobro/)
  expect(emails()[0]!.html).toContain("https://checkout.onvopay.com/authorize/test_y")
  const payment = await prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } })
  expect(payment.status).toBe("PENDING")
  // el dueño confirmó con su banco pero no volvió a la página: la vuelta siguiente lo detecta
  await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } })
  await processBilling()
  expect((await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("SUCCEEDED")
  expect((await subOf(sub.id)).paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * DAY)
})

it("rechazada: avisa, reintenta una vez por día hasta 3 veces y después pasa a solo lectura con aviso", async () => {
  const { sub } = await paidOwner(new Date(Date.now() - HOURS(1)))
  confirmAs = "declined"
  await processBilling()
  expect(emails().map((e) => e.subject)).toEqual(["No pudimos cobrar tu plan de Cubivo"])
  expect(emails()[0]!.html).toContain("Lo intentaremos de nuevo mañana")
  // la misma hora no reintenta
  await processBilling()
  expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id } })).toBe(1)
  // pasan los días: segundo y tercer intento
  // (los intentos quedan dentro de la ventana de este vencimiento, pero de hace más de un día)
  for (let i = 0; i < 2; i++) {
    await prisma.subscriptionPayment.updateMany({ where: { subscriptionId: sub.id }, data: { createdAt: new Date(Date.now() - DAY - HOURS(0.5)) } })
    await processBilling()
  }
  expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id, status: "FAILED" } })).toBe(3)
  expect(emails().at(-1)!.html).toContain("Ya no lo vamos a reintentar")
  // venció la gracia: ya no cobra y avisa una sola vez que quedó en solo lectura
  await prisma.subscription.update({ where: { id: sub.id }, data: { paidUntil: new Date(Date.now() - 4 * DAY) } })
  const before = calls.filter((c) => c.url.endsWith("/confirm")).length
  await processBilling()
  await processBilling()
  expect(calls.filter((c) => c.url.endsWith("/confirm"))).toHaveLength(before)
  expect(emails().filter((e) => /solo lectura/.test(e.subject))).toHaveLength(1)
})

it("avisos: prueba por terminar y recordatorio a quien paga por SINPE, una sola vez cada uno", async () => {
  const trial = await createUser("ADMIN")
  await prisma.subscription.create({ data: { userId: trial.user.id, trialEndsAt: inDays(2) } })
  const sinpe = await paidOwner(inDays(2), false)
  const later = await createUser("ADMIN")
  await prisma.subscription.create({ data: { userId: later.user.id, trialEndsAt: inDays(10) } })
  await processBilling()
  await processBilling()
  const sent = emails()
  expect(sent.filter((e) => e.to === trial.user.email).map((e) => e.subject)).toEqual([expect.stringMatching(/^Tu prueba de Cubivo termina/)])
  expect(sent.filter((e) => e.to === sinpe.admin.user.email).map((e) => e.subject)).toEqual([expect.stringMatching(/^Tu plan de Cubivo vence/)])
  expect(sent.some((e) => e.to === later.user.email)).toBe(false)
  // sin tarjeta no intenta cobrar
  expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(false)
})

it("si el correo falla, el aviso se reintenta en la siguiente vuelta", async () => {
  const trial = await createUser("ADMIN")
  await prisma.subscription.create({ data: { userId: trial.user.id, trialEndsAt: inDays(1) } })
  delete process.env.RESEND_API_KEY
  await processBilling()
  expect(await prisma.billingNotice.count()).toBe(0)
  process.env.RESEND_API_KEY = "re_prueba"
  await processBilling()
  expect(emails()).toHaveLength(1)
})

it("un pago pendiente de más de 24 horas se cancela en ONVO y queda fallido", async () => {
  const { sub } = await paidOwner(inDays(20), false)
  const p = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, method: "SINPE", plan: "BASIC", interval: "MONTHLY", amount: 14900, onvoIntentId: "pi_viejo", createdAt: new Date(Date.now() - 25 * HOURS(1)) },
  })
  intentOnGet = "processing"
  await processBilling()
  expect(calls.some((c) => c.url.endsWith("/pi_viejo/cancel"))).toBe(true)
  expect(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "FAILED", failureMessage: "No llegó la transferencia a tiempo" })
})

it("la demo y las cuentas internas no se cobran ni reciben avisos", async () => {
  const demo = await paidOwner(new Date(Date.now() - HOURS(1)))
  await prisma.user.update({ where: { id: demo.admin.user.id }, data: { isDemo: true } })
  const internal = await paidOwner(new Date(Date.now() - HOURS(1)))
  await prisma.subscription.update({ where: { id: internal.sub.id }, data: { exempt: true } })
  await processBilling()
  expect(calls).toHaveLength(0)
})

function HOURS(h: number) {
  return h * 60 * 60 * 1000
}

it("C5: cancelada no se cobra ni recibe recordatorio; con un cambio programado la renovación cobra el plan nuevo", async () => {
  const cancelled = await paidOwner(new Date(Date.now() + HOURS(2)))
  await prisma.subscription.update({ where: { id: cancelled.sub.id }, data: { cancelAtPeriodEnd: true } })
  const downgrade = await paidOwner(new Date(Date.now() + HOURS(2)))
  await prisma.user.update({ where: { id: downgrade.admin.user.id }, data: { plan: "PRO" } })
  await prisma.subscription.update({ where: { id: downgrade.sub.id }, data: { nextPlan: "BASIC" } })
  await processBilling()
  expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: cancelled.sub.id } })).toBe(0)
  const p = await prisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: downgrade.sub.id } })
  expect(p).toMatchObject({ plan: "BASIC", amount: 14900, status: "SUCCEEDED" })
  expect((await prisma.user.findUniqueOrThrow({ where: { id: downgrade.admin.user.id } })).plan).toBe("BASIC")
  expect((await subOf(downgrade.sub.id)).nextPlan).toBeNull()
})


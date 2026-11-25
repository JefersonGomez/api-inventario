// Fase de cobro C1: prueba gratis, elegir plan y periodo, días de gracia y solo lectura al vencer. C2: pago con tarjeta
import { jest } from "@jest/globals"
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { subscriptionState } from "./billing.state.ts"

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const inDays = (days: number) => new Date(Date.now() + days * DAY)

describe("estado de la suscripción (solo fechas)", () => {
  const now = new Date("2026-12-01T12:00:00Z")
  const at = (iso: string) => new Date(iso)
  it("prueba, al día, gracia, vencida y exenta", () => {
    expect(subscriptionState({ trialEndsAt: at("2026-12-10T12:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "trial", daysLeft: 9 })
    expect(subscriptionState({ trialEndsAt: at("2026-11-01T00:00:00Z"), paidUntil: at("2026-12-31T00:00:00Z"), exempt: false }, now)).toMatchObject({ state: "active", daysLeft: 30 })
    // venció hace 1 día → 2 días de gracia
    expect(subscriptionState({ trialEndsAt: at("2026-11-30T12:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "grace", daysLeft: 2 })
    // la gracia cuenta desde lo último que tenía: un periodo pagado que venció después de la prueba
    expect(subscriptionState({ trialEndsAt: at("2026-10-01T00:00:00Z"), paidUntil: at("2026-11-30T00:00:00Z"), exempt: false }, now).state).toBe("grace")
    expect(subscriptionState({ trialEndsAt: at("2026-11-20T00:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "expired", daysLeft: 0 })
    expect(subscriptionState({ trialEndsAt: at("2020-01-01T00:00:00Z"), paidUntil: null, exempt: true }, now).state).toBe("exempt")
  })
})

describe("suscripción de la cuenta", () => {
  beforeEach(async () => {
    await resetDb()
  })
  afterEach(() => {
    delete process.env.BILLING_ENABLED
  })
  afterAll(async () => {
    await resetDb()
  })

  it("GET /plans publica los precios y los días de prueba", async () => {
    const res = await request(app).get("/plans")
    expect(res.body.find((p: { code: string }) => p.code === "BASIC")).toMatchObject({ prices: { monthly: 14900, annual: 12400 }, trialDays: 14 })
  })

  it("apagado (sin BILLING_ENABLED) nadie vence ni se bloquea", async () => {
    const admin = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: ago(30) } })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ enabled: false, isOwner: true, plan: "BASIC" })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Tornillos" })).status).toBe(201)
  })

  it("registrarse empieza la prueba de 14 días del plan elegido", async () => {
    process.env.BILLING_ENABLED = "1"
    await request(app).post("/auth/register").send({ acceptTerms: true, name: "Ana", email: "ana@prueba.cr", password: "Clave-segura-1", plan: "INVOICING" })
    const login = await request(app).post("/auth/login").send({ email: "ana@prueba.cr", password: "Clave-segura-1" })
    const auth = { Authorization: `Bearer ${login.body.accessToken ?? login.body.token}` }
    const sub = await request(app).get("/billing/subscription").set(auth)
    expect(sub.body).toMatchObject({ enabled: true, isOwner: true, plan: "INVOICING", interval: "MONTHLY", state: "trial", daysLeft: 14 })
    expect(sub.body.prices.INVOICING).toEqual({ monthly: 5900, annual: 4900 })
  })

  it("una cuenta de antes del cobro empieza su prueba la primera vez que se mira", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    expect(await prisma.subscription.count({ where: { userId: admin.user.id } })).toBe(0)
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "trial", daysLeft: 14 })
    expect(await prisma.subscription.count({ where: { userId: admin.user.id } })).toBe(1)
  })

  it("solo el dueño elige plan y periodo; los demás ven el estado", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    const cashier = await createUser("CASHIER", admin.companyId)
    const res = await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "PRO", interval: "ANNUAL" })
    expect(res.body).toMatchObject({ plan: "PRO", interval: "ANNUAL", state: "trial" })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).plan).toBe("PRO")
    expect((await request(app).get("/billing/subscription").set(cashier.auth)).body).toMatchObject({ isOwner: false, plan: "PRO", state: "trial" })
    expect((await request(app).put("/billing/subscription").set(cashier.auth).send({ plan: "BASIC" })).body.code).toBe("BILLING_OWNER_ONLY")
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({})).status).toBe(400)
    // con un periodo pagado vigente el cambio es de la fase C5
    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { paidUntil: inDays(20) } })
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "BASIC" })).body.code).toBe("BILLING_PAID_CHANGE")
  })

  it("al vencer: 3 días de gracia con todo funcionando, después solo lectura", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    const cashier = await createUser("CASHIER", admin.companyId)
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: ago(1) } })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "grace", daysLeft: 2 })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "En gracia" })).status).toBe(201)

    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { trialEndsAt: ago(4) } })
    const blocked = await request(app).post("/categories").set(admin.auth).send({ name: "Vencida" })
    expect(blocked.status).toBe(402)
    expect(blocked.body.code).toBe("SUBSCRIPTION_EXPIRED")
    // a toda la empresa, no solo al dueño
    expect((await request(app).post("/categories").set(cashier.auth).send({ name: "Vencida 2" })).status).toBe(402)
    // ver y exportar sigue
    expect((await request(app).get("/categories").set(admin.auth)).status).toBe(200)
    // y puede elegir plan para pagar
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "BASIC" })).status).toBe(200)

    // pagó (C2 lo hará solo): vuelve a funcionar
    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { paidUntil: inDays(30) } })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Al día" })).status).toBe(201)
  })

  it("la demo y las cuentas internas nunca vencen", async () => {
    process.env.BILLING_ENABLED = "1"
    const demo = await createUser("ADMIN")
    await prisma.user.update({ where: { id: demo.user.id }, data: { isDemo: true } })
    expect((await request(app).get("/billing/subscription").set(demo.auth)).body.state).toBe("exempt")
    expect((await request(app).post("/categories").set(demo.auth).send({ name: "Demo" })).status).toBe(201)

    const internal = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: internal.user.id, trialEndsAt: ago(100), exempt: true } })
    expect((await request(app).post("/categories").set(internal.auth).send({ name: "Interna" })).status).toBe(201)
  })
})

// Pago con tarjeta (C2): ONVO simulado (las respuestas imitan las reales del modo prueba del 25-nov-2026)
describe("pago con tarjeta (ONVO)", () => {
  type Call = { method: string; url: string; body: Record<string, unknown> | null }
  let calls: Call[] = []
  // cómo responde ONVO al confirmar
  let confirmAs: "ok" | "3ds" | "declined" | "sinpe" = "ok"
  let pmCustomer = "cus_1"
  let n = 0

  beforeEach(async () => {
    await resetDb()
    calls = []
    confirmAs = "ok"
    pmCustomer = "cus_1"
    process.env.BILLING_ENABLED = "1"
    process.env.ONVO_SECRET_KEY = "onvo_test_secret_key_x"
    process.env.ONVO_PUBLISHABLE_KEY = "onvo_test_publishable_key_x"
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
      const card = { id: "pm_1", customerId: pmCustomer, status: "active", card: { brand: "Visa", last4: "4242" } }
      if (url.endsWith("/v1/customers")) return json({ id: "cus_1" }, 201)
      if (url.includes("/v1/payment-methods/")) return json(card)
      if (method === "POST" && url.endsWith("/v1/payment-methods")) return json({ id: "pm_sinpe", type: "mobile_number", customerId: body!.customerId }, 201)
      if (method === "POST" && url.endsWith("/v1/payment-intents")) return json({ id: `pi_${++n}`, status: "requires_payment_method", amount: body!.amount }, 201)
      if (url.endsWith("/confirm")) {
        const id = url.split("/").at(-2)
        if (confirmAs === "sinpe") return json({ id, status: "processing" }, 201)
        if (confirmAs === "ok") return json({ id, status: "succeeded", paymentMethod: card }, 201)
        if (confirmAs === "3ds") return json({ id, status: "requires_action", nextAction: { type: "redirect_to_url", redirectToUrl: { url: "https://checkout.onvopay.com/authorize/test_x" } } }, 201)
        return json({ id, status: "requires_payment_method", lastPaymentError: { code: "card_declined", message: "Tarjeta rechazada" } }, 201)
      }
      if (url.includes("/v1/payment-intents/")) return json({ id: url.split("/").at(-1), status: "succeeded", paymentMethod: card })
      return json({ message: "no simulado" }, 404)
    })
  })
  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env.ONVO_SECRET_KEY
    delete process.env.ONVO_PUBLISHABLE_KEY
    delete process.env.BILLING_ENABLED
  })

  async function owner() {
    const admin = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: inDays(5) } })
    return admin
  }

  it("registra la tarjeta, cobra el plan y la cuenta queda al día sin perder los días de prueba", async () => {
    const admin = await owner()
    const setup = await request(app).get("/billing/card-setup").set(admin.auth)
    expect(setup.body).toEqual({ publishableKey: "onvo_test_publishable_key_x", customerId: "cus_1" })
    // la segunda vez no crea otro cliente en ONVO
    await request(app).get("/billing/card-setup").set(admin.auth)
    expect(calls.filter((c) => c.url.endsWith("/v1/customers"))).toHaveLength(1)

    const paid = await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })
    expect(paid.status).toBe(201)
    expect(paid.body.payment).toMatchObject({ status: "SUCCEEDED", amount: 14900, plan: "BASIC", interval: "MONTHLY", cardLast4: "4242" })
    expect(paid.body.redirectUrl).toBeUndefined()
    // a ONVO va en céntimos, en colones, con el cliente de la cuenta, y vuelve a /subscription
    const intent = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/payment-intents"))!
    expect(intent.body).toMatchObject({ amount: 1490000, currency: "CRC", customerId: "cus_1" })
    expect(String(calls.find((c) => c.url.endsWith("/confirm"))!.body!.returnUrl)).toMatch(/\/subscription\?payment=/)

    const sub = await request(app).get("/billing/subscription").set(admin.auth)
    expect(sub.body).toMatchObject({ state: "active", card: { brand: "Visa", last4: "4242" }, cardPayments: true })
    // el mes empieza cuando termina la prueba (quedaban 5 días)
    expect(new Date(sub.body.paidUntil).getTime()).toBeGreaterThan(inDays(5 + 27).getTime())
    expect((await request(app).get("/billing/payments").set(admin.auth)).body).toHaveLength(1)

    // el mes siguiente: sin mandar tarjeta se cobra a la guardada
    const again = await request(app).post("/billing/pay").set(admin.auth).send({})
    expect(again.body.payment).toMatchObject({ status: "SUCCEEDED", cardLast4: "4242" })
    expect(calls.filter((c) => c.url.endsWith("/confirm")).at(-1)!.body!.paymentMethodId).toBe("pm_1")
  })

  it("anual cobra los 12 meses con el precio anual", async () => {
    const admin = await owner()
    await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "PRO", interval: "ANNUAL" })
    await request(app).get("/billing/card-setup").set(admin.auth)
    const paid = await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })
    expect(paid.body.payment).toMatchObject({ status: "SUCCEEDED", amount: 24900 * 12, plan: "PRO", interval: "ANNUAL" })
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: admin.user.id } })
    expect(sub.paidUntil!.getTime()).toBeGreaterThan(inDays(5 + 360).getTime())
  })

  it("si el banco pide verificar (3DS): devuelve la URL y al volver se confirma una sola vez", async () => {
    const admin = await owner()
    await request(app).get("/billing/card-setup").set(admin.auth)
    confirmAs = "3ds"
    const res = await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })
    expect(res.body).toMatchObject({ payment: { status: "PENDING" }, redirectUrl: "https://checkout.onvopay.com/authorize/test_x" })
    // la tarjeta para renovar cambia solo cuando el banco confirma
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body.card).toBeNull()
    // mientras tanto no deja empezar otro cobro
    expect((await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })).body.code).toBe("BILLING_PAYMENT_PENDING")

    const id = res.body.payment.id
    expect((await request(app).post(`/billing/payments/${id}/sync`).set(admin.auth)).body).toMatchObject({ status: "SUCCEEDED" })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body.card).toEqual({ brand: "Visa", last4: "4242" })
    const until = (await prisma.subscription.findUniqueOrThrow({ where: { userId: admin.user.id } })).paidUntil
    // volver a sincronizar no suma otro mes
    await request(app).post(`/billing/payments/${id}/sync`).set(admin.auth)
    expect((await prisma.subscription.findUniqueOrThrow({ where: { userId: admin.user.id } })).paidUntil).toEqual(until)
  })

  it("tarjeta rechazada: el pago queda fallido con el motivo y la cuenta sigue igual", async () => {
    const admin = await owner()
    await request(app).get("/billing/card-setup").set(admin.auth)
    confirmAs = "declined"
    const res = await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })
    expect(res.body.payment).toMatchObject({ status: "FAILED", failureMessage: expect.stringMatching(/rechazó/) })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "trial", card: null })
  })

  it("no se puede pagar con una tarjeta de otra cuenta, ni si no es el dueño", async () => {
    const admin = await owner()
    const cashier = await createUser("CASHIER", admin.companyId)
    await request(app).get("/billing/card-setup").set(admin.auth)
    pmCustomer = "cus_de_otro"
    expect((await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })).body.code).toBe("BILLING_CARD_OWNER")
    expect(calls.some((c) => c.url.endsWith("/v1/payment-intents"))).toBe(false)
    expect((await request(app).get("/billing/card-setup").set(cashier.auth)).body.code).toBe("BILLING_OWNER_ONLY")
    expect((await request(app).get("/billing/payments").set(cashier.auth)).status).toBe(403)
  })

  it("una cuenta vencida (solo lectura) puede pagar y vuelve a funcionar", async () => {
    const admin = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: ago(10) } })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "X" })).status).toBe(402)
    await request(app).get("/billing/card-setup").set(admin.auth)
    expect((await request(app).post("/billing/pay").set(admin.auth).send({ paymentMethodId: "pm_1" })).body.payment.status).toBe("SUCCEEDED")
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "X" })).status).toBe(201)
  })

  it("SINPE Móvil: da el número y el monto exacto, y al llegar la transferencia la cuenta queda al día", async () => {
    const admin = await owner()
    confirmAs = "sinpe"
    const res = await request(app).post("/billing/pay-sinpe").set(admin.auth).send({ idType: "FISICA", idNumber: "1-1393-1919", phone: "8888-8888" })
    expect(res.status).toBe(201)
    expect(res.body.payment).toMatchObject({ status: "PENDING", method: "SINPE", amount: 14900, sinpe: { to: "7019-6686", amount: 14900, identification: "01-1393-1919" } })
    // a ONVO: identificación con guiones (formato de ONVO), tipo 0 (física) y el teléfono con +506
    const pm = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/payment-methods"))!
    expect(pm.body).toMatchObject({ type: "mobile_number", customerId: "cus_1", mobileNumber: { identification: "01-1393-1919", identificationType: 0, number: "+50688888888" } })
    // mientras espera, el historial muestra las instrucciones y no deja generar otro
    expect((await request(app).get("/billing/payments").set(admin.auth)).body[0].sinpe.to).toBe("7019-6686")
    expect((await request(app).post("/billing/pay-sinpe").set(admin.auth).send({ idType: "FISICA", idNumber: "113931919", phone: "88888888" })).body.code).toBe("BILLING_PAYMENT_PENDING")

    // llegó la transferencia: ONVO la da por buena
    const synced = await request(app).post(`/billing/payments/${res.body.payment.id}/sync`).set(admin.auth)
    expect(synced.body).toMatchObject({ status: "SUCCEEDED", method: "SINPE" })
    expect(synced.body.sinpe).toBeUndefined()
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "active", card: null })
  })

  it("SINPE Móvil: formato de cédula jurídica y datos mal escritos", async () => {
    const admin = await owner()
    confirmAs = "sinpe"
    const bad = (body: object) => request(app).post("/billing/pay-sinpe").set(admin.auth).send(body)
    expect((await bad({ idType: "FISICA", idNumber: "1234567890", phone: "88888888" })).body.code).toBe("BILLING_SINPE_ID")
    expect((await bad({ idType: "FISICA", idNumber: "113931919", phone: "2222-3333" })).body.code).toBe("BILLING_SINPE_PHONE")
    await bad({ idType: "JURIDICA", idNumber: "3101123456", phone: "+506 7012-3456" })
    const pm = calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/payment-methods")).at(-1)!
    expect(pm.body!.mobileNumber).toEqual({ identification: "3-101-123456", identificationType: 3, number: "+50670123456" })
  })
})

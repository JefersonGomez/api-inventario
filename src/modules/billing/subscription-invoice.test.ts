// C6: cada pago confirmado de una suscripción genera la factura electrónica de Cubivo (la emite la empresa
// de la plataforma) a nombre del cliente; sin cédula, tiquete. Una sola vez, y sin PLATFORM_COMPANY_ID nada.
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { invoicePendingPayments, invoiceSubscriptionPayment } from "./subscription-invoice.service.ts"

let platform: Awaited<ReturnType<typeof createUser>>

beforeEach(async () => {
  await resetDb()
  platform = await createUser("ADMIN") // la empresa de Cubivo que emite
  process.env.PLATFORM_COMPANY_ID = platform.companyId
})
afterEach(() => {
  delete process.env.PLATFORM_COMPANY_ID
  delete process.env.PLATFORM_CABYS
})
afterAll(async () => {
  await resetDb()
})

async function paidClient(fiscal: boolean, kind: "PERIOD" | "UPGRADE" = "PERIOD") {
  const client = await createUser("ADMIN")
  await prisma.company.update({
    where: { id: client.companyId },
    data: { name: "Ferretería Prueba", ...(fiscal && { legalName: "Ferretería Prueba S.A.", idType: "JURIDICA", idNumber: "3101123456", invoiceEmail: "facturas@ferre.cr" }) },
  })
  const sub = await prisma.subscription.create({ data: { userId: client.user.id, trialEndsAt: new Date() } })
  const payment = await prisma.subscriptionPayment.create({
    data: {
      subscriptionId: sub.id, plan: "PRO", interval: "MONTHLY", amount: 29900, status: "SUCCEEDED", method: "CARD", kind,
      onvoIntentId: "pi_123", paidAt: new Date(), periodStart: new Date("2026-12-01T12:00:00Z"), periodEnd: new Date("2027-01-01T12:00:00Z"),
    },
  })
  return { client, payment }
}

it("con cédula: FACTURA a nombre del cliente, una línea de servicio con el CABYS de software, pagada con tarjeta", async () => {
  const { payment } = await paidClient(true)
  const docId = await invoiceSubscriptionPayment(payment.id)
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId! }, include: { lines: true, payments: true, customer: true } })
  expect(doc).toMatchObject({ companyId: platform.companyId, type: "INVOICE", terminalCode: "99998" })
  expect(Number(doc.total)).toBe(29900)
  expect(doc.customer).toMatchObject({ name: "Ferretería Prueba S.A.", idType: "JURIDICA", idNumber: "3101123456", email: "facturas@ferre.cr", companyId: platform.companyId })
  expect(doc.lines).toHaveLength(1)
  expect(doc.lines[0]).toMatchObject({ cabys: "8439200000000", taxRate: "RATE_13" })
  expect(doc.lines[0]!.description).toMatch(/^Suscripción Cubivo plan Pro mensual \(01\/12\/2026 al 01\/01\/2027\)/)
  expect(doc.payments[0]).toMatchObject({ method: "CARD", reference: "pi_123" })
  expect(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ documentId: docId, invoiceError: null })
  // una sola vez
  expect(await invoiceSubscriptionPayment(payment.id)).toBeNull()
  expect(await prisma.document.count({ where: { companyId: platform.companyId } })).toBe(1)
})

it("sin cédula: TIQUETE con su correo; el mismo cliente se reutiliza en el siguiente pago", async () => {
  const { client, payment } = await paidClient(false)
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: (await invoiceSubscriptionPayment(payment.id))! }, include: { customer: true } })
  expect(doc.type).toBe("TICKET")
  expect(doc.customer).toMatchObject({ name: "Ferretería Prueba", email: client.user.email, idNumber: null })
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: client.user.id } })
  const second = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, plan: "PRO", interval: "MONTHLY", amount: 7500, status: "SUCCEEDED", method: "SINPE", kind: "UPGRADE", paidAt: new Date() },
  })
  const doc2 = await prisma.document.findUniqueOrThrow({ where: { id: (await invoiceSubscriptionPayment(second.id))! }, include: { lines: true, payments: true } })
  expect(doc2.customerId).toBe(doc.customerId)
  expect(doc2.lines[0]!.description).toBe("Cambio a plan Pro de Cubivo")
  expect(doc2.payments[0]!.method).toBe("SINPE")
  expect(await prisma.customer.count({ where: { companyId: platform.companyId } })).toBe(1)
})

it("sin empresa emisora no hace nada; si falla queda el motivo y la revisión de cada hora la reintenta", async () => {
  const { payment } = await paidClient(true)
  delete process.env.PLATFORM_COMPANY_ID
  expect(await invoiceSubscriptionPayment(payment.id)).toBeNull()
  expect(await prisma.document.count()).toBe(0)

  process.env.PLATFORM_COMPANY_ID = "00000000-0000-4000-8000-000000000000" // mal configurada
  await expect(invoiceSubscriptionPayment(payment.id)).rejects.toThrow(/PLATFORM_COMPANY_ID/)
  expect((await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).invoiceError).toMatch(/PLATFORM_COMPANY_ID/)

  process.env.PLATFORM_COMPANY_ID = platform.companyId
  await invoicePendingPayments()
  expect(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ invoiceError: null, documentId: expect.any(String) })
})

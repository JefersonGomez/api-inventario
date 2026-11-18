// Nota de débito: cargo extra sobre una factura o un tiquete (Bloque 9, punto 47)
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Nota de débito", () => {
  let admin: User, cashier: User
  let saleId: string, customerId: string, bankId: string
  const charge = { description: "Intereses por atraso", quantity: 1, unitPriceWithTax: 2260, taxRate: "RATE_13", cabys: "7113000000000" }
  const debit = (who: User, id: string, body: object) => request(app).post(`/sales/${id}/debit-notes`).set(who.auth).send(body)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    cashier = await createUser("CASHIER", admin.companyId)
    const main = await mainLocationId(admin.companyId)
    const categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Herramientas" } })).id
    const productId = (await request(app).post("/products").set(admin.auth).send({
      sku: "MRT", name: "Martillo", price: 5650, stock: 10, minStock: 0, categoryId, cabys: "4292199990200", locationId: main,
    })).body.id
    customerId = (await request(app).post("/customers").set(admin.auth).send({ name: "Constructora Los Pinos S.A.", idType: "JURIDICA", idNumber: "3101123456" })).body.id
    bankId = (await request(app).post("/banks/accounts").set(admin.auth).send({ name: "BN colones", bankName: "Banco Nacional", currency: "CRC" })).body.id
    saleId = (await request(app).post("/sales/invoices").set(admin.auth)
      .send({ customerId, lines: [{ productId, quantity: 1 }], payment: { method: "TRANSFER" } })).body.document.id
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("de contado: cargo ligado a la venta, el pago a la cuenta bancaria y se ve en Ventas", async () => {
    const res = await debit(admin, saleId, { reason: "Intereses por pago atrasado", lines: [charge], payment: { method: "TRANSFER", reference: "TRF-1", bankAccountId: bankId } })
    expect(res.status).toBe(201)
    const doc = res.body.document
    expect(doc).toMatchObject({ type: "DEBIT_NOTE", referenceDocumentId: saleId, referenceReason: "Intereses por pago atrasado", terminalCode: "99999" })
    expect(Number(doc.total)).toBe(2260)
    expect(doc.consecutive).toMatch(/^0019999902\d{10}$/) // 02 = nota de débito
    const payments = await prisma.documentPayment.findMany({ where: { documentId: doc.id } })
    expect(payments).toEqual([expect.objectContaining({ method: "TRANSFER", bankAccountId: bankId })])
    expect(await prisma.stockMovement.count({ where: { sourceId: doc.id } })).toBe(0) // un cargo no mueve inventario

    // en la venta original aparece el cargo; la nota misma se abre como nota
    const sale = (await request(app).get(`/sales/${saleId}`).set(admin.auth)).body
    expect(sale.debitNotes).toEqual([expect.objectContaining({ id: doc.id, referenceReason: "Intereses por pago atrasado" })])
    const note = (await request(app).get(`/sales/${doc.id}`).set(admin.auth)).body
    expect(note).toMatchObject({ document: { type: "DEBIT_NOTE" }, debitNotes: [] })
    const list = (await request(app).get("/sales?kind=DEBIT_NOTE").set(admin.auth)).body.items
    expect(list.map((d: { id: string }) => d.id)).toEqual([doc.id])
  })

  it("a crédito solo si el cliente tiene crédito; no sobre otra nota; los cajeros no", async () => {
    const credit = { reason: "Diferencia de precio", lines: [charge], credit: { frequency: "MONTHLY", installments: 1 } }
    expect((await debit(admin, saleId, credit)).body.code).toBe("CREDIT_CUSTOMER")
    await request(app).put(`/receivables/${customerId}/credit`).set(admin.auth).send({ creditLimit: 100000 })
    const res = await debit(admin, saleId, credit)
    expect(res.status).toBe(201)
    expect(await prisma.installment.count({ where: { documentId: res.body.document.id } })).toBe(1)

    expect((await debit(admin, res.body.document.id, { reason: "x cargo", lines: [charge], payment: { method: "SINPE" } })).body.code).toBe("DEBIT_ORIGINAL")
    expect((await debit(admin, saleId, { reason: "Sin CABYS", lines: [{ ...charge, cabys: undefined }], payment: { method: "SINPE" } })).status).toBe(400)
    expect((await debit(cashier, saleId, { reason: "Intento", lines: [charge], payment: { method: "SINPE" } })).status).toBe(403)
  })
})

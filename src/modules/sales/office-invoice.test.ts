// Factura desde la oficina, sin caja (Bloque 9, punto 47)
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Factura desde la oficina", () => {
  let admin: User, manager: User, cashier: User
  let main: string, hammerId: string, customerId: string, noIdId: string, bankId: string
  const invoice = (who: User, body: object) => request(app).post("/sales/invoices").set(who.auth).send(body)
  const stockAt = async (productId: string, locationId: string) =>
    Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId, locationId } } }))?.quantity ?? 0)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    manager = await createUser("MANAGER", admin.companyId)
    cashier = await createUser("CASHIER", admin.companyId)
    main = await mainLocationId(admin.companyId)
    const categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Herramientas" } })).id
    hammerId = (await request(app).post("/products").set(admin.auth).send({
      sku: "MRT", name: "Martillo", price: 5650, cost: 3000, stock: 10, minStock: 0, categoryId, cabys: "4292199990200", locationId: main,
    })).body.id
    customerId = (await request(app).post("/customers").set(admin.auth)
      .send({ name: "Constructora Los Pinos S.A.", idType: "JURIDICA", idNumber: "3101123456", email: "compras@pinos.cr" })).body.id
    noIdId = (await request(app).post("/customers").set(admin.auth).send({ name: "Cliente sin cédula" })).body.id
    bankId = (await request(app).post("/banks/accounts").set(admin.auth).send({ name: "BN colones", bankName: "Banco Nacional", currency: "CRC" })).body.id
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("de contado: factura a nombre del cliente, sale del stock y el pago queda en la cuenta bancaria", async () => {
    const res = await invoice(manager, {
      customerId, locationId: main,
      lines: [
        { productId: hammerId, quantity: 2 },
        { description: "Flete a la obra", quantity: 1, unitPriceWithTax: 11300, taxRate: "RATE_13", cabys: "6511100000000" },
      ],
      payment: { method: "TRANSFER", reference: "TRF-998877", bankAccountId: bankId },
      notes: "Entrega en la obra de San Pedro",
    })
    expect(res.status).toBe(201)
    const doc = res.body.document
    expect(doc).toMatchObject({ type: "INVOICE", saleCondition: "CASH", terminalCode: "99999", customer: expect.objectContaining({ name: "Constructora Los Pinos S.A." }) })
    expect(Number(doc.total)).toBe(22600) // 2 × 5650 + 11300
    expect(doc.consecutive).toMatch(/^0019999901\d{10}$/) // sucursal 001, terminal de oficina 99999, factura 01
    // la mercadería sale del stock; el flete no lleva producto
    expect(await stockAt(hammerId, main)).toBe(8)
    const moves = await prisma.stockMovement.findMany({ where: { sourceId: doc.id } })
    expect(moves).toEqual([expect.objectContaining({ type: "OUT", source: "SALE", productId: hammerId })])
    expect(Number(moves[0]!.quantity)).toBe(2)
    // el pago, completo y en la cuenta elegida
    const payments = await prisma.documentPayment.findMany({ where: { documentId: doc.id } })
    expect(payments).toEqual([expect.objectContaining({ method: "TRANSFER", reference: "TRF-998877", bankAccountId: bankId })])
    expect(Number(payments[0]!.amount)).toBe(22600)
    // la línea del producto guarda su costo (para la ganancia) y la del servicio su CABYS
    const lines = await prisma.documentLine.findMany({ where: { documentId: doc.id }, orderBy: { lineNumber: "asc" } })
    expect(Number(lines[0]!.unitCost)).toBe(3000)
    expect(lines[1]).toMatchObject({ productId: null, description: "Flete a la obra", cabys: "6511100000000" })
    // aparece en Ventas
    expect((await request(app).get(`/sales/${doc.id}`).set(admin.auth)).body.document.id).toBe(doc.id)
  })

  it("a crédito: cuotas con el límite del cliente; sin crédito autorizado no se puede", async () => {
    const credit = { customerId, lines: [{ productId: hammerId, quantity: 1 }], credit: { frequency: "MONTHLY", installments: 2 } }
    expect((await invoice(admin, credit)).body.code).toBe("CREDIT_CUSTOMER")
    await request(app).put(`/receivables/${customerId}/credit`).set(admin.auth).send({ creditLimit: 100000 })
    const res = await invoice(admin, credit)
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ saleCondition: "CREDIT" })
    const installments = await prisma.installment.findMany({ where: { documentId: res.body.document.id }, orderBy: { number: "asc" } })
    expect(installments.map((i) => Number(i.amount))).toEqual([2825, 2825])
    expect(await prisma.documentPayment.count({ where: { documentId: res.body.document.id } })).toBe(0)
    // pasa el límite
    const tooMuch = await invoice(admin, { ...credit, lines: [{ description: "Instalación", quantity: 1, unitPriceWithTax: 200000, taxRate: "RATE_13", cabys: "5461100000000" }] })
    expect(tooMuch.body.code).toBe("CREDIT_LIMIT")
  })

  it("valida el cliente, el stock, la forma de pago y quién puede facturar", async () => {
    const base = { lines: [{ productId: hammerId, quantity: 1 }], payment: { method: "SINPE" } }
    expect((await invoice(admin, { ...base, customerId: noIdId })).body.code).toBe("INVOICE_CUSTOMER_ID")
    const short = await invoice(admin, { ...base, customerId, lines: [{ productId: hammerId, quantity: 50 }] })
    expect(short.body).toMatchObject({ code: "INVOICE_STOCK" })
    expect(short.body.error).toMatch(/No alcanza el stock/)
    expect((await invoice(admin, { customerId, lines: base.lines })).status).toBe(400) // ni contado ni crédito
    expect((await invoice(admin, { ...base, customerId, credit: { frequency: "MONTHLY", installments: 1 } })).status).toBe(400) // las dos
    expect((await invoice(admin, { ...base, customerId, lines: [{ description: "Servicio", quantity: 1 }] })).status).toBe(400) // servicio sin precio
    expect((await invoice(admin, { ...base, customerId, lines: [{ description: "Flete", quantity: 1, unitPriceWithTax: 5000, taxRate: "RATE_13" }] })).status).toBe(400) // servicio sin CABYS
    expect((await invoice(cashier, { ...base, customerId })).status).toBe(403) // los cajeros facturan en la caja
    expect(await stockAt(hammerId, main)).toBe(7) // lo rechazado no movió nada
  })
})

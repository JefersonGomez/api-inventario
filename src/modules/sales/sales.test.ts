// Bloque 7C: devoluciones con nota de crédito (parcial/total, estado del producto, reembolso, crédito, plazo)
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Ventas y devoluciones", () => {
  let admin: User, manager: User, cashier: User
  let productId: string, main: string, managerPin: string
  const stock = async () => Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId, locationId: main } } }))?.quantity ?? 0)
  const sell = (body: object) => request(app).post("/pos/sales").set(cashier.auth).send(body)
  const giveBack = (saleId: string, body: object) => request(app).post(`/sales/${saleId}/returns`).set(cashier.auth).send({ reason: "No le sirvió", ...body })
  const lineOf = async (saleId: string) => (await request(app).get(`/sales/${saleId}`).set(cashier.auth)).body.document.lines[0].id

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "ARZ", name: "Arroz", price: 1130, stock: 10, minStock: 0, categoryId: category.id, locationId: main })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 10000 })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("devolución parcial: código del encargado, buen estado vuelve al stock y el efectivo sale de la caja", async () => {
    const sale = (await sell({ lines: [{ productId, quantity: 3 }], payments: [{ method: "CASH", amount: 3390 }] })).body.document
    expect(await stock()).toBe(7)
    const lineId = await lineOf(sale.id)

    expect((await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], refund: { method: "CASH" } })).status).toBe(400) // sin código
    expect((await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], refund: { method: "CASH" }, pin: "4821" })).body.code).toBe("RETURN_PIN")

    const res = await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], refund: { method: "CASH" }, pin: managerPin })
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ type: "CREDIT_NOTE", referenceDocument: { id: sale.id }, returnAuthorizedBy: { id: manager.user.id } })
    expect(Number(res.body.document.total)).toBeCloseTo(1130, 2)
    expect(res.body.refund).toBe(1130)
    expect(await stock()).toBe(8)
    const summary = (await request(app).get("/pos/session").set(cashier.auth)).body.summary
    expect(summary).toMatchObject({ refunds: { CASH: 1130 } })

    // no más de lo que queda; lo dañado no vuelve al stock y avisa a inventario
    expect((await giveBack(sale.id, { lines: [{ lineId, quantity: 3, condition: "GOOD" }], refund: { method: "CASH" }, pin: managerPin })).body.error).toMatch(/solo quedan 2/)
    const damaged = await giveBack(sale.id, { lines: [{ lineId, quantity: 2, condition: "DAMAGED" }], refund: { method: "CARD", reference: "77" }, pin: managerPin })
    expect(damaged.status).toBe(201)
    expect(await stock()).toBe(8)
    expect(await prisma.notification.count({ where: { type: "returnDamaged" } })).toBe(2) // admin y encargado

    const detail = (await request(app).get(`/sales/${sale.id}`).set(cashier.auth)).body
    expect(detail.returned[lineId]).toBe(3)
    expect(detail.creditNotes).toHaveLength(2)
    expect((await request(app).get("/sales?kind=CREDIT_NOTE").set(cashier.auth)).body.total).toBe(2)
  })

  it("venta a crédito: primero rebaja las cuotas desde la última; lo que sobra se reembolsa", async () => {
    const customerId = (await request(app).post("/customers").set(cashier.auth).send({ name: "Ana Mora", idType: "FISICA", idNumber: "101110111" })).body.id
    await request(app).put(`/receivables/${customerId}/credit`).set(admin.auth).send({ creditLimit: 5000 })
    const sale = (await sell({ customerId, lines: [{ productId, quantity: 2 }], credit: { frequency: "MONTHLY", installments: 2 }, creditPin: managerPin })).body.document
    await request(app).post("/receivables/payments").set(cashier.auth).send({ customerId, amount: 1000, method: "CASH", inRegister: true })
    const lineId = await lineOf(sale.id)

    // 1130 de vuelta: la última cuota (1130 pendiente) desaparece, no hay reembolso
    const first = await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], pin: managerPin })
    expect(first.body).toMatchObject({ credited: 1130, refund: 0 })
    expect((await request(app).get(`/receivables/${customerId}`).set(cashier.auth)).body.balance).toBe(130)

    // la otra: rebaja los 130 que debe y le devuelve los 1000 que ya pagó
    const second = { lines: [{ lineId, quantity: 1, condition: "GOOD" }], pin: managerPin }
    expect((await giveBack(sale.id, second)).body.error).toMatch(/cómo se le devuelven 1000\.00/)
    expect((await giveBack(sale.id, { ...second, refund: { method: "SINPE", reference: "SP-1" } })).body).toMatchObject({ credited: 130, refund: 1000 })
    expect((await request(app).get(`/receivables/${customerId}`).set(cashier.auth)).body.balance).toBe(0)
  })

  it("pasado el plazo de la empresa no se devuelve", async () => {
    const sale = (await sell({ lines: [{ productId, quantity: 1 }], payments: [{ method: "CARD", amount: 1130, reference: "AUT1" }] })).body.document
    // el comprobante es inmutable: solo el test lo envejece, con el trigger apagado
    await prisma.$executeRawUnsafe(`ALTER TABLE "Document" DISABLE TRIGGER "Document_immutable"`)
    await prisma.document.update({ where: { id: sale.id }, data: { issuedAt: new Date(Date.now() - 31 * 86_400_000) } })
    await prisma.$executeRawUnsafe(`ALTER TABLE "Document" ENABLE TRIGGER "Document_immutable"`)
    const lineId = await lineOf(sale.id)
    const res = await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], refund: { method: "CARD" }, pin: managerPin })
    expect(res.body.code).toBe("RETURN_EXPIRED")
    await request(app).put("/company").set(admin.auth).send({ returnDays: 60 })
    expect((await giveBack(sale.id, { lines: [{ lineId, quantity: 1, condition: "GOOD" }], refund: { method: "CARD" }, pin: managerPin })).status).toBe(201)
  })
})

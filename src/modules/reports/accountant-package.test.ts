// Paquete para el contador (parte A): IVA, ventas por comprobante y movimientos de bancos del mes
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>
type Doc = { type: string; customer: { name: string } | null; reference: string | null; total: number; tax: number; byRate: Record<string, { base: number; tax: number }>; payments: Record<string, number> }
type Tx = { reference: string; status: string; matchedWith: string[]; category: string | null }

describe("Paquete para el contador", () => {
  let admin: User, manager: User, cashier: User, other: User
  const today = new Date().toLocaleDateString("sv")
  const month = today.slice(0, 7)
  const pkg = (who: User = admin, m = month) => request(app).get(`/reports/accountant-package?month=${m}`).set(who.auth)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    other = await createUser("ADMIN")
    const managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const productId = (await request(app).post("/products").set(admin.auth).send({ sku: "ARZ", name: "Arroz", price: 1130, stock: 20, minStock: 0, categoryId: category.id, locationId: main })).body.id
    await prisma.product.update({ where: { id: productId }, data: { taxRate: "RATE_13" } })
    const accountId = (await request(app).post("/banks/accounts").set(admin.auth).send({ name: "BN", bankName: "Banco Nacional", currency: "CRC", general: true, locationIds: [main] })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })

    const sell = (body: object) => request(app).post("/pos/sales").set(cashier.auth).send({ lines: [{ productId, quantity: 2 }], ...body })
    await sell({ payments: [{ method: "SINPE", amount: 2260, reference: "51604453" }] })
    const cash = (await sell({ payments: [{ method: "CASH", amount: 2260 }] })).body.document
    const lineId = (await request(app).get(`/sales/${cash.id}`).set(cashier.auth)).body.document.lines[0].id
    await request(app).post(`/sales/${cash.id}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "GOOD" }], reason: "Cambio", refund: { method: "CASH" }, pin: managerPin })

    // estado del banco: el SINPE (se concilia), la comisión (se clasifica), uno sin revisar y uno del mes anterior
    const lastMonth = new Date(`${month}-01T12:00:00`)
    lastMonth.setDate(0)
    await request(app).post(`/banks/accounts/${accountId}/import`).set(admin.auth).send({
      fileName: "estado.csv",
      rows: [
        { date: today, reference: "51604453", description: "SINPE CLIENTE", amount: 2260 },
        { date: today, reference: "5", description: "COMISION", amount: -675 },
        { date: today, reference: "9", description: "DEPOSITO DESCONOCIDO", amount: 4000 },
        { date: lastMonth.toLocaleDateString("sv"), reference: "1", description: "VIEJO", amount: 100 },
      ],
    })
    const tx = new Map((await prisma.bankTransaction.findMany({ where: { bankAccountId: accountId } })).map((t) => [t.reference, t.id]))
    const rec = (await request(app).get(`/banks/accounts/${accountId}/reconcile?from=${today}&to=${today}`).set(admin.auth)).body
    const sinpe = rec.items.find((i: { reference: string }) => i.reference === "51604453").suggestion
    await request(app).post(`/banks/transactions/${tx.get("51604453")}/match`).set(admin.auth).send({ items: [{ type: sinpe.type, id: sinpe.id }] })
    await request(app).patch(`/banks/transactions/${tx.get("5")}`).set(admin.auth).send({ category: "BANK_FEE" })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("ventas por comprobante: la nota de crédito resta y apunta a su venta", async () => {
    const p = (await pkg()).body
    expect(p.month).toBe(month)
    expect(p.vat.liquidation.debit).toBe(390) // 520 vendido − 130 devuelto
    const docs = p.sales.documents as Doc[]
    expect(docs.map((d) => d.type)).toEqual(["TICKET", "TICKET", "CREDIT_NOTE"])
    expect(docs[0]).toMatchObject({ total: 2260, tax: 260, byRate: { RATE_13: { base: 2000, tax: 260 } }, payments: { SINPE: 2260 } })
    expect(docs[2]).toMatchObject({ total: -1130, tax: -130, byRate: { RATE_13: { base: -1000, tax: -130 } }, payments: { CASH: -1130 } })
    expect(docs[2]!.reference).toMatch(/^\d{20}$/)
    expect(p.sales.totals).toMatchObject({ count: 3, subtotal: 3000, tax: 390, total: 3390 })
  })

  it("bancos: conciliado, clasificado y pendiente; solo el mes pedido", async () => {
    const [bank] = (await pkg()).body.banks
    expect(bank.account).toMatchObject({ name: "BN", currency: "CRC" })
    const by = new Map((bank.transactions as Tx[]).map((t) => [t.reference, t]))
    expect([...by.keys()].sort()).toEqual(["5", "51604453", "9"])
    expect(by.get("51604453")).toMatchObject({ status: "MATCHED", matchedWith: [expect.any(String)] })
    expect(by.get("5")).toMatchObject({ status: "CLASSIFIED", category: "BANK_FEE" })
    expect(by.get("9")).toMatchObject({ status: "PENDING" })
    expect(bank.totals).toEqual({ credits: 6260, debits: -675, pending: 1 })
  })

  it("permisos y aislamiento", async () => {
    expect((await pkg(cashier)).status).toBe(403)
    expect((await pkg(admin, "2026-1")).status).toBe(400)
    const theirs = (await pkg(other)).body
    expect(theirs.sales.documents).toEqual([])
    expect(theirs.banks).toEqual([])
  })
})

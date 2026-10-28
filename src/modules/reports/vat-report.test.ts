// Punto 54B: IVA del mes (Formulario 150) — ventas por tarifa, compras acreditables, prorrata y liquidación
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>
const rowOf = (rows: { rate: string }[], rate: string) => rows.find((r) => r.rate === rate)

describe("IVA del mes", () => {
  let admin: User, manager: User, accountant: User, cashier: User, employee: User, other: User
  let supplierId: string
  const today = new Date().toLocaleDateString("sv")
  const month = today.slice(0, 7)
  const shift = (m: string, by: number) => {
    const d = new Date(`${m}-15T12:00:00`)
    d.setMonth(d.getMonth() + by)
    return d.toLocaleDateString("sv").slice(0, 7)
  }
  const report = (m: string, who: User = admin) => request(app).get(`/reports/vat?month=${m}`).set(who.auth)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    accountant = await createUser("ACCOUNTANT", c)
    cashier = await createUser("CASHIER", c)
    employee = await createUser("EMPLOYE", c)
    other = await createUser("ADMIN") // otra empresa
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const product = (body: object) => request(app).post("/products").set(admin.auth).send({ minStock: 0, categoryId: category.id, locationId: main, stock: 20, ...body })
    const rice = (await product({ sku: "ARZ", name: "Arroz", price: 1130 })).body.id // 13 %: 1000 + 130
    const beans = (await product({ sku: "FRJ", name: "Frijoles", price: 1000 })).body.id
    await prisma.product.update({ where: { id: rice }, data: { taxRate: "RATE_13" } })
    await prisma.product.update({ where: { id: beans }, data: { taxRate: "EXEMPT" } })
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })

    // ventas: 3 arroz (3000 + 390) y 2 frijoles exentos (2000); se devuelve 1 arroz (−1000 − 130)
    const sale = (await request(app).post("/pos/sales").set(cashier.auth).send({
      lines: [{ productId: rice, quantity: 3 }, { productId: beans, quantity: 2 }],
      payments: [{ method: "CASH", amount: 5390 }],
    })).body.document
    const lineId = (await request(app).get(`/sales/${sale.id}`).set(cashier.auth)).body.document.lines.find((l: { productId: string }) => l.productId === rice).id
    await request(app).post(`/sales/${sale.id}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "GOOD" }], reason: "Cambio", refund: { method: "CASH" }, pin: managerPin })

    // compras del mes: una acreditable (13 % y 1 %), una no acreditable, una anulada y una del mes anterior
    supplierId = (await request(app).post("/suppliers").set(admin.auth).send({ name: "Distribuidora Central" })).body.id
    const invoice = (body: object) => request(app).post("/payables/invoices").set(admin.auth).send({ supplierId, issueDate: today, ...body })
    await invoice({ number: "F-1", lines: [{ rate: "RATE_13", base: 1000 }, { rate: "RATE_1", base: 500 }] })
    await invoice({ number: "F-2", creditable: false, lines: [{ rate: "RATE_13", base: 200 }] })
    const voided = (await invoice({ number: "F-3", lines: [{ rate: "RATE_13", base: 9999 }] })).body
    await request(app).post(`/payables/invoices/${voided.id}/void`).set(admin.auth).send({ reason: "Duplicada" })
    await invoice({ number: "F-0", issueDate: `${shift(month, -1)}-10`, lines: [{ rate: "RATE_13", base: 7000 }] })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("ventas por tarifa netas de devoluciones, compras acreditables y liquidación", async () => {
    const r = (await report(month)).body
    expect(rowOf(r.sales.rows, "RATE_13")).toMatchObject({ grossBase: 3000, returnsBase: 1000, base: 2000, tax: 260 })
    expect(rowOf(r.sales.rows, "EXEMPT")).toMatchObject({ base: 2000, tax: 0 })
    expect(r.sales.totals).toMatchObject({ base: 4000, tax: 260 })

    expect(rowOf(r.purchases.creditable.rows, "RATE_13")).toMatchObject({ base: 1000, tax: 130 })
    expect(rowOf(r.purchases.creditable.rows, "RATE_1")).toMatchObject({ base: 500, tax: 5 })
    expect(r.purchases.nonCreditable.totals).toMatchObject({ base: 200, tax: 26 })
    expect(r.purchases.invoices.map((i: { number: string }) => i.number)).toEqual(["F-1", "F-2"]) // sin la anulada ni la del mes anterior

    // gravadas y exentas: la prorrata aplica; sin anotarla se usa el 100 %
    expect(r.prorata).toMatchObject({ value: null, source: "none", applies: true, suggestedMonth: 50 })
    expect(r.liquidation).toMatchObject({ debit: 260, creditableTax: 135, credit: 135, cardWithholding: 0, balance: 125, toPay: 125, inFavor: 0 })
  })

  it("prorrata y retención de tarjeta anotadas a mano; el mes siguiente hereda la prorrata", async () => {
    const save = (m: string, body: object, who: User = accountant) => request(app).put(`/reports/vat?month=${m}`).set(who.auth).send(body)
    expect((await save(month, { prorata: 120, cardWithholding: 0 })).status).toBe(400)
    expect((await save(month, { prorata: 80, cardWithholding: 20 }, cashier)).status).toBe(403)
    expect((await save(month, { prorata: 80, cardWithholding: 20, note: "Prorrata del contador" })).status).toBe(200)

    const r = (await report(month, accountant)).body
    expect(r.prorata).toMatchObject({ value: 80, source: "month" })
    expect(r.liquidation).toMatchObject({ credit: 108, cardWithholding: 20, balance: 132, toPay: 132 })
    expect(r.period).toMatchObject({ note: "Prorrata del contador", updatedBy: { id: accountant.user.id } })

    const next = (await report(shift(month, 1))).body
    expect(next.prorata).toMatchObject({ value: 80, source: "inherited", inheritedFrom: month, applies: false })
    expect(next.liquidation).toMatchObject({ debit: 0, credit: 0, balance: 0 })

    // el mes anterior: solo la compra (7000 + 910) y queda saldo a favor
    const prev = (await report(shift(month, -1))).body
    expect(prev.prorata.source).toBe("none")
    expect(prev.liquidation).toMatchObject({ credit: 910, balance: -910, toPay: 0, inFavor: 910 })
  })

  it("permisos, validación y aislamiento entre empresas", async () => {
    expect((await report(month, cashier)).status).toBe(403)
    expect((await report(month, employee)).status).toBe(403)
    expect((await report("2026-13")).status).toBe(400)
    const theirs = (await report(month, other)).body
    expect(theirs.sales.totals).toMatchObject({ base: 0, tax: 0 })
    expect(theirs.purchases.invoices).toEqual([])
    expect(theirs.prorata.source).toBe("none")
  })
})

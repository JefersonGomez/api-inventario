// Bloque 7D-1: reporte de ventas, ventas de hoy y las del cajero
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { runWithCompany } from "../../shared/tenant.ts"
import { toolExecutors } from "../assistant/assistant.tools.ts"
import { salesOfDay } from "./sales-report.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Reporte de ventas", () => {
  let admin: User, manager: User, cashier: User, employee: User
  let productId: string, otherId: string, managerPin: string
  const today = new Date().toLocaleDateString("sv")

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    employee = await createUser("EMPLOYE", c)
    managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const product = (body: object) => request(app).post("/products").set(admin.auth).send({ minStock: 0, categoryId: category.id, locationId: main, ...body })
    productId = (await product({ sku: "ARZ", name: "Arroz", price: 1130, stock: 20 })).body.id
    otherId = (await product({ sku: "FRJ", name: "Frijoles", price: 2260, stock: 5 })).body.id
    await prisma.product.update({ where: { id: productId }, data: { cost: 600 } }) // 1000 sin IVA → 400 de ganancia por unidad
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })

    const sell = (body: object) => request(app).post("/pos/sales").set(cashier.auth).send(body)
    await sell({ lines: [{ productId, quantity: 3 }], payments: [{ method: "CASH", amount: 3390 }] })
    const card = (await sell({ lines: [{ productId, quantity: 1 }], payments: [{ method: "CARD", amount: 1130 }] })).body.document
    // devolución de la venta con tarjeta
    const lineId = (await request(app).get(`/sales/${card.id}`).set(cashier.auth)).body.document.lines[0].id
    await request(app).post(`/sales/${card.id}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "GOOD" }], reason: "Cambio", refund: { method: "CARD" }, pin: managerPin })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("totales, medios de pago, por cajero, productos, ganancia y lo que no se vendió", async () => {
    expect((await request(app).get(`/reports/sales?from=${today}&to=${today}`).set(cashier.auth)).status).toBe(403)
    const r = (await request(app).get(`/reports/sales?from=${today}&to=${today}`).set(admin.auth)).body
    expect(r.totals).toMatchObject({ gross: 4520, returns: 1130, net: 3390, tickets: 2, average: 2260 })
    expect(r.byMethod).toMatchObject({ CASH: 3390, CARD: 1130 })
    expect(r.byCashier).toEqual([expect.objectContaining({ id: cashier.user.id, gross: 4520, returns: 1130, net: 3390, tickets: 2 })])
    expect(r.byDay.find((d: { date: string }) => d.date === today)).toMatchObject({ net: 3390 })
    expect(r.products).toEqual([expect.objectContaining({ productId, quantity: 3, amount: 3390 })])
    expect(r.profit).toMatchObject({ revenue: 3000, cost: 1800, profit: 1200, margin: 40 })
    expect(r.notSold.map((p: { id: string }) => p.id)).toContain(otherId)

    // sin permiso de costos no hay ganancia
    await request(app).patch(`/users/${employee.user.id}/access`).set(admin.auth).send({ role: "EMPLOYE", revokedPermissions: ["costs.view"] })
    const noCost = (await request(app).get(`/reports/sales?from=${today}&to=${today}`).set(employee.auth)).body
    expect(noCost.profit).toBeNull()
    expect((await request(app).get(`/reports/sales?from=${today}&to=2020-01-01`).set(admin.auth)).status).toBe(400)
  })

  it("la ganancia usa el costo guardado al vender; lo devuelto dañado es pérdida", async () => {
    await prisma.product.update({ where: { id: productId }, data: { cost: 900 } })
    const profit = async () => (await request(app).get(`/reports/sales?from=${today}&to=${today}`).set(admin.auth)).body.profit
    expect(await profit()).toMatchObject({ revenue: 3000, cost: 1800, profit: 1200 }) // las ventas de antes siguen con 600

    // una venta nueva (guarda 900) devuelta dañada: no queda venta, pero el costo se pierde
    const sale = (await request(app).post("/pos/sales").set(cashier.auth).send({ lines: [{ productId, quantity: 1 }], payments: [{ method: "CASH", amount: 1130 }] })).body.document
    const lineId = (await request(app).get(`/sales/${sale.id}`).set(cashier.auth)).body.document.lines[0].id
    await request(app).post(`/sales/${sale.id}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "DAMAGED" }], reason: "Roto", refund: { method: "CASH" }, pin: managerPin })
    expect(await profit()).toMatchObject({ revenue: 3000, cost: 2700, profit: 300 })
  })

  it("el asistente y el resumen del día ven las ventas; la ganancia solo con costos", async () => {
    const ask = (permissions: string[]) => runWithCompany(admin.companyId, () => toolExecutors.getSalesReport!({ from: today, to: today }, { permissions })) as Promise<Record<string, unknown>>
    expect(await ask([])).toMatchObject({ totals: { net: 3390 } })
    expect((await ask([])).profit).toBeUndefined()
    expect((await ask(["costs.view"])).profit).toMatchObject({ profit: 300 })
    const start = new Date(new Date().setHours(0, 0, 0, 0))
    expect(await runWithCompany(admin.companyId, () => salesOfDay(start))).toMatchObject({ net: 3390, tickets: 3, topProducts: ["Arroz"] })
    expect((await request(app).get("/company/onboarding").set(admin.auth)).body.steps.find((st: { key: string }) => st.key === "firstRegister")).toMatchObject({ done: true })
  })

  it("ventas de hoy para el Panel y las del cajero en el mes", async () => {
    expect((await request(app).get("/reports/sales-today").set(manager.auth)).body.today).toMatchObject({ net: 3390, tickets: 3 })
    const mine = (await request(app).get("/reports/my-sales").set(cashier.auth)).body
    expect(mine).toMatchObject({ gross: 5650, returns: 2260, net: 3390, tickets: 3, returnsCount: 2 })
    expect((await request(app).get("/reports/my-sales").set(employee.auth)).status).toBe(403)
  })
})

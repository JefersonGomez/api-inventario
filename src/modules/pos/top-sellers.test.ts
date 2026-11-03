// Fase 3 de mejoras (3-nov-2026): filtro "Más vendidos" del POS
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Más vendidos del POS", () => {
  let admin: User, cashier: User
  let cable: string, rice: string, beans: string, pin: string
  const names = (r: request.Response) => (r.body.items as { name: string }[]).map((p) => p.name)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    cashier = await createUser("CASHIER", c)
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const manager = await createUser("MANAGER", c)
    pin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const product = async (body: object) =>
      (await request(app).post("/products").set(admin.auth).send({ minStock: 0, categoryId: category.id, locationId: main, stock: 500, ...body })).body.id
    cable = await product({ sku: "CBL", name: "Cable", price: 650 })
    rice = await product({ sku: "ARZ", name: "Arroz", price: 1130 })
    beans = await product({ sku: "FRJ", name: "Frijoles", price: 1000 })
    await product({ sku: "SAL", name: "Sal", price: 500 }) // nunca se vende
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  const sell = (lines: { productId: string; quantity: number }[], amount: number) =>
    request(app).post("/pos/sales").set(cashier.auth).send({ lines, payments: [{ method: "CASH", amount }] })

  it("sin ventas todavía: la lista normal", async () => {
    const r = await request(app).get("/products?view=flat&topSelling=1").set(cashier.auth)
    expect(names(r)).toEqual(["Arroz", "Cable", "Frijoles", "Sal"])
    expect((await request(app).get("/pos/catalog").set(cashier.auth)).body.topSellers).toEqual([])
  })

  it("ordena por cantidad de ventas (no por unidades) y deja afuera lo que no se vendió", async () => {
    await sell([{ productId: cable, quantity: 100 }], 65000) // muchas unidades, una sola venta
    for (let i = 0; i < 3; i++) await sell([{ productId: rice, quantity: 1 }], 1130)
    const both = (await sell([{ productId: rice, quantity: 1 }, { productId: beans, quantity: 1 }], 2130)).body.document
    await sell([{ productId: beans, quantity: 1 }], 1000)
    // una devolución no resta: la venta ya ocurrió
    const lineId = (await request(app).get(`/sales/${both.id}`).set(cashier.auth)).body.document.lines[0].id
    await request(app).post(`/sales/${both.id}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "GOOD" }], reason: "Cambio", refund: { method: "CASH" }, pin })

    const r = await request(app).get("/products?view=flat&topSelling=1").set(cashier.auth)
    expect(names(r)).toEqual(["Arroz", "Frijoles", "Cable"]) // 4, 2 y 1 ventas
    expect(r.body.items[0].stock).toBeDefined()
    // el catálogo de la caja trae el mismo orden para usarlo sin conexión
    expect((await request(app).get("/pos/catalog").set(cashier.auth)).body.topSellers).toEqual([rice, beans, cable])
  })

  it("un producto borrado no aparece", async () => {
    await request(app).delete(`/products/${beans}`).set(admin.auth)
    expect(names(await request(app).get("/products?view=flat&topSelling=1").set(cashier.auth))).toEqual(["Arroz", "Cable"])
  })
})

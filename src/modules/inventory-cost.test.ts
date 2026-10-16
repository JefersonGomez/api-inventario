// Valor del inventario a costo: costo promedio ponderado al recibir órdenes y reportes
import request from "supertest"
import app from "../app.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../test/helpers.ts"

describe("Valor del inventario a costo", () => {
  let admin: Awaited<ReturnType<typeof createUser>>
  let categoryId: string
  let supplierId: string

  beforeEach(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "C" } })).id
    supplierId = (await prisma.supplier.create({ data: { companyId: admin.companyId, name: "P" } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  const makeProduct = (data: { sku: string; stock: number; price?: number; cost?: number | null; deletedAt?: Date }) =>
    prisma.product.create({
      data: { companyId: admin.companyId, name: data.sku, price: data.price ?? 100, minStock: 0, categoryId, ...data },
    })

  async function receive(productId: string, quantity: number, unitCost: number) {
    const order = await request(app).post("/purchase-orders").set(admin.auth)
      .send({ supplierId, items: [{ productId, quantity, unitCost }] })
    expect(order.status).toBe(201)
    const received = await request(app).patch(`/purchase-orders/${order.body.id}/receive`).set(admin.auth)
    expect(received.status).toBe(200)
  }

  const costOf = async (id: string) => Number((await prisma.product.findUniqueOrThrow({ where: { id } })).cost)

  it("recibir una orden promedia el costo con el stock que había", async () => {
    const p = await makeProduct({ sku: "A", stock: 10, cost: 50 })
    await receive(p.id, 10, 70) // (10×50 + 10×70) / 20 = 60
    expect(await costOf(p.id)).toBe(60)
    await receive(p.id, 20, 90) // (20×60 + 20×90) / 40 = 75
    expect(await costOf(p.id)).toBe(75)
  })

  it("sin costo previo o sin stock, el costo pasa a ser el de la compra", async () => {
    const noCost = await makeProduct({ sku: "B", stock: 5, cost: null })
    await receive(noCost.id, 5, 40)
    expect(await costOf(noCost.id)).toBe(40)

    const noStock = await makeProduct({ sku: "C", stock: 0, cost: 999 })
    await receive(noStock.id, 4, 30)
    expect(await costOf(noStock.id)).toBe(30)
  })

  it("un movimiento manual no cambia el costo", async () => {
    const p = await makeProduct({ sku: "D", stock: 10, cost: 50 })
    await request(app).post("/movements").set(admin.auth).send({ productId: p.id, type: "IN", quantity: 5 })
    expect(await costOf(p.id)).toBe(50)
  })

  it("el reporte valora a costo, deja aparte los sin costo y no cuenta eliminados", async () => {
    await makeProduct({ sku: "E", stock: 10, price: 100, cost: 40 }) // 400 a costo, 1000 a venta
    await makeProduct({ sku: "F", stock: 5, price: 200, cost: null }) // sin costo
    await makeProduct({ sku: "G", stock: 0, price: 50, cost: null }) // sin stock: no es "sin costo"
    await makeProduct({ sku: "H", stock: 100, price: 100, cost: 10, deletedAt: new Date() }) // eliminado

    const res = await request(app).get("/reports/inventory-value").set(admin.auth)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totalValue: 400, retailValue: 2000, totalProducts: 3, productsWithoutCost: 1 })
  })

  it("el desglose a costo suma activo + inmovilizado y lista los sin costo", async () => {
    const withMove = await makeProduct({ sku: "I", stock: 10, cost: 10 }) // 100
    const idle = await makeProduct({ sku: "J", stock: 3, cost: 20 }) // 60
    const idleNoCost = await makeProduct({ sku: "K", stock: 2, cost: null })
    await prisma.stockMovement.create({
      data: { companyId: admin.companyId, productId: withMove.id, userId: admin.user.id, type: "IN", quantity: 1, locationId: await mainLocationId(admin.companyId) },
    })
    // movimientos viejos de los otros dos: ya no cuentan como actividad reciente
    const loc = await mainLocationId(admin.companyId)
    await prisma.stockMovement.createMany({
      data: [idle.id, idleNoCost.id].map((productId) => ({
        companyId: admin.companyId, productId, userId: admin.user.id, type: "IN" as const, quantity: 1, locationId: loc,
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      })),
    })

    const res = await request(app).get("/reports/inventory-value-breakdown?days=60").set(admin.auth)
    expect(res.body).toMatchObject({ totalValue: 160, activeValue: 100, immobilizedValue: 60, productsWithoutCost: 1 })
    expect(res.body.immobilizedProducts.map((p: { sku: string; hasCost: boolean }) => [p.sku, p.hasCost])).toEqual([
      ["J", true],
      ["K", false],
    ])
  })

  it("el costo se carga y se edita a mano en el producto; null lo borra", async () => {
    const created = await request(app).post("/products").set(admin.auth)
      .send({ sku: "L", name: "L", price: 100, cost: 55.5, stock: 1, minStock: 0, categoryId })
    expect(created.status).toBe(201)
    expect(Number(created.body.cost)).toBe(55.5)

    const edit = (extra: object) =>
      request(app).put(`/products/${created.body.id}`).set(admin.auth)
        .send({ name: "L", price: 100, minStock: 0, categoryId, ...extra })
    expect(Number((await edit({ cost: 60 })).body.cost)).toBe(60)
    expect(Number((await edit({})).body.cost)).toBe(60) // sin el campo: no se toca
    expect((await edit({ cost: null })).body.cost).toBeNull()
    expect((await edit({ cost: -1 })).status).toBe(400)
  })
})

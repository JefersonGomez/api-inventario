// Bloque 5C: lotes con vencimiento (solo productos marcados) y salidas FEFO
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()

describe("Lotes con vencimiento", () => {
  let admin: User
  let main: string, bodega: string, categoryId: string, milkId: string
  const lots = async (productId = milkId, locationId = main) =>
    (await prisma.productLot.findMany({ where: { productId, locationId }, orderBy: { code: "asc" } }))
      .map((l) => [l.code, Number(l.quantity)])
  const move = (body: object) => request(app).post("/movements").set(admin.auth).send({ productId: milkId, ...body })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    main = await mainLocationId(admin.companyId)
    bodega = (await request(app).post("/locations").set(admin.auth).send({ name: "Bodega", type: "WAREHOUSE" })).body.id
    categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Lácteos" } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("un producto con lotes pide el lote al entrar; el inicial entra a su lote", async () => {
    const noLot = await request(app).post("/products").set(admin.auth)
      .send({ sku: "LECHE", name: "Leche", price: 900, stock: 10, minStock: 0, categoryId, tracksLots: true })
    expect(noLot.body.error).toMatch(/indica el lote/)

    const res = await request(app).post("/products").set(admin.auth).send({
      sku: "LECHE", name: "Leche", price: 900, stock: 10, minStock: 0, categoryId, tracksLots: true,
      lot: { code: "L-A", expiresAt: day(20) },
    })
    expect(res.status).toBe(201)
    milkId = res.body.id
    expect(await lots()).toEqual([["L-A", 10]])

    expect((await move({ type: "IN", quantity: 5 })).body.error).toMatch(/indica el lote/)
    await move({ type: "IN", quantity: 5, lot: { code: "L-B", expiresAt: day(3) } })
    await move({ type: "IN", quantity: 4, lot: { code: "L-C" } }) // sin vencimiento: sale de último
    expect(await lots()).toEqual([["L-A", 10], ["L-B", 5], ["L-C", 4]])
  })

  it("las salidas toman primero el lote que vence antes (FEFO)", async () => {
    const res = await move({ type: "OUT", quantity: 7 })
    expect(res.status).toBe(201)
    expect(await lots()).toEqual([["L-A", 8], ["L-B", 0], ["L-C", 4]]) // 5 de L-B (vence en 3 días) + 2 de L-A
    const movement = await prisma.stockMovement.findUniqueOrThrow({ where: { id: res.body.id } })
    expect((movement.lots as { code: string; quantity: number }[]).map((l) => [l.code, l.quantity])).toEqual([["L-B", 5], ["L-A", 2]])
    expect((await move({ type: "OUT", quantity: 50 })).status).toBe(400)
  })

  it("una orden de compra recibe cada línea en su lote", async () => {
    const supplier = await prisma.supplier.create({ data: { companyId: admin.companyId, name: "Lechería" } })
    const order = (await request(app).post("/purchase-orders").set(admin.auth)
      .send({ supplierId: supplier.id, items: [{ productId: milkId, quantity: 6, unitCost: 500 }] })).body
    // recibir todo sin lote no se puede con un producto que maneja lotes
    expect((await request(app).patch(`/purchase-orders/${order.id}/receive`).set(admin.auth)).body.error).toMatch(/indica el lote/)
    const res = await request(app).patch(`/purchase-orders/${order.id}/receive`).set(admin.auth)
      .send({ items: [{ itemId: order.items[0].id, quantity: 6, lot: { code: "L-D", expiresAt: day(30) } }] })
    expect(res.body.status).toBe("RECEIVED")
    expect(await lots()).toContainEqual(["L-D", 6])
  })

  it("en una transferencia los lotes viajan: salen por vencimiento y llegan con su código", async () => {
    const t = (await request(app).post("/transfers").set(admin.auth)
      .send({ fromLocationId: main, toLocationId: bodega, items: [{ productId: milkId, quantity: 10 }] })).body
    // en main: L-A 8 (vence en 20), L-C 4 (sin fecha), L-D 6 (vence en 30) → salen 8 de L-A y 2 de L-D
    expect(await lots()).toEqual([["L-A", 0], ["L-B", 0], ["L-C", 4], ["L-D", 4]])
    await request(app).post(`/transfers/${t.id}/receive`).set(admin.auth).send({ items: [{ itemId: t.items[0].id, receivedQuantity: 9 }] })
    expect(await lots(milkId, bodega)).toEqual([["L-A", 8], ["L-D", 1]]) // llegó lo que vence antes; faltó 1
  })

  it("un conteo con sobrante lo deja en SIN-LOTE y el faltante sale por vencimiento", async () => {
    const count = (await request(app).post("/stock-counts").set(admin.auth).send({ locationId: bodega, categoryId })).body
    await request(app).put(`/stock-counts/${count.id}/items`).set(admin.auth).send({ items: [{ productId: milkId, countedQuantity: 11 }] })
    await request(app).post(`/stock-counts/${count.id}/close`).set(admin.auth)
    expect(await lots(milkId, bodega)).toEqual([["L-A", 8], ["L-D", 1], ["SIN-LOTE", 2]])
  })

  it("al marcar un producto con stock, lo que había pasa a un lote INICIAL; avisa los lotes por vencer", async () => {
    const plain = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "QUESO", name: "Queso", price: 2000, stock: 3, minStock: 0, categoryId })).body
    expect(await lots(plain.id)).toEqual([])
    await request(app).put(`/products/${plain.id}`).set(admin.auth)
      .send({ name: "Queso", price: 2000, minStock: 0, categoryId, tracksLots: true, expirationDate: day(2) })
    expect(await lots(plain.id)).toEqual([["INICIAL", 3]])
    const detail = (await request(app).get(`/products/${plain.id}`).set(admin.auth)).body
    expect(detail.lots).toEqual([expect.objectContaining({ code: "INICIAL", quantity: 3, location: expect.objectContaining({ id: main }) })])

    const notes = (await request(app).get("/notifications").set(admin.auth)).body.notifications
    const expiring = notes.filter((n: { type: string }) => n.type === "productExpiring").map((n: { title: string }) => n.title)
    expect(expiring).toContain("Queso · INICIAL")
    expect(expiring).not.toContain("Leche · L-B") // vacío: no avisa
  })
})

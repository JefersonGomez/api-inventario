// Bloque 4B: transferencias entre ubicaciones en dos pasos
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Transferencias entre ubicaciones", () => {
  let admin: User, branchClerk: User, warehouseClerk: User, accountant: User
  let main: string, bodega: string, productId: string
  const stockAt = async (locationId: string, id = productId) =>
    Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId: id, locationId } } }))?.quantity ?? 0)
  const total = async (id = productId) => Number((await prisma.product.findUniqueOrThrow({ where: { id } })).stock)
  const send = (u: User, body: object) => request(app).post("/transfers").set(u.auth).send(body)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    main = await mainLocationId(c)
    bodega = (await request(app).post("/locations").set(admin.auth).send({ name: "Bodega", type: "WAREHOUSE" })).body.id
    branchClerk = await createUser("EMPLOYE", c)
    warehouseClerk = await createUser("EMPLOYE", c)
    accountant = await createUser("ACCOUNTANT", c)
    await request(app).patch(`/users/${branchClerk.user.id}/access`).set(admin.auth).send({ role: "EMPLOYE", locationIds: [main] })
    await request(app).patch(`/users/${warehouseClerk.user.id}/access`).set(admin.auth).send({ role: "EMPLOYE", locationIds: [bodega] })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "CEM", name: "Cemento", price: 5000, stock: 50, minStock: 0, categoryId: category.id, locationId: bodega })).body.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("enviar: sale del origen, queda en tránsito (sigue en el total) y avisa al destino", async () => {
    const res = await send(warehouseClerk, { toLocationId: main, items: [{ productId, quantity: 20 }], notes: "Pedido de la semana" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: "IN_TRANSIT", fromLocation: { id: bodega }, toLocation: { id: main } })
    expect(await stockAt(bodega)).toBe(30)
    expect(await stockAt(main)).toBe(0)
    expect(await total()).toBe(50) // los 20 en tránsito siguen siendo de la empresa
    expect((await request(app).get(`/products/${productId}`).set(admin.auth)).body.inTransit).toBe(20)

    const notes = (await request(app).get("/notifications").set(branchClerk.auth)).body.notifications
    expect(notes.some((n: { type: string }) => n.type === "transferIncoming")).toBe(true)
    const moves = await prisma.stockMovement.findMany({ where: { source: "TRANSFER", sourceId: res.body.id } })
    expect(moves).toEqual([expect.objectContaining({ type: "OUT", locationId: bodega })])
  })

  it("validaciones al enviar", async () => {
    expect((await send(warehouseClerk, { toLocationId: main, items: [{ productId, quantity: 999 }] })).body.error).toMatch(/Stock insuficiente en Bodega/)
    expect((await send(warehouseClerk, { toLocationId: bodega, items: [{ productId, quantity: 1 }] })).body.error).toMatch(/distintos/)
    expect((await send(warehouseClerk, { toLocationId: main, items: [{ productId, quantity: 1 }, { productId, quantity: 2 }] })).body.error).toMatch(/repetidos/)
    // solo se envía desde donde uno trabaja
    expect((await send(branchClerk, { fromLocationId: bodega, toLocationId: main, items: [{ productId, quantity: 1 }] })).body.error).toMatch(/No trabajas/)
    expect((await send(accountant, { toLocationId: main, items: [{ productId, quantity: 1 }] })).status).toBe(403)
    expect(await stockAt(bodega)).toBe(30) // nada se movió
  })

  it("recibir con faltante: entra lo que llegó y la diferencia sale del total", async () => {
    const t = (await request(app).get("/transfers?status=IN_TRANSIT").set(branchClerk.auth)).body.items[0]
    // quien no trabaja en el destino no puede recibir
    expect((await request(app).post(`/transfers/${t.id}/receive`).set(warehouseClerk.auth)).body.error).toMatch(/No trabajas/)
    const tooMuch = await request(app).post(`/transfers/${t.id}/receive`).set(branchClerk.auth).send({ items: [{ itemId: t.items[0].id, receivedQuantity: 25 }] })
    expect(tooMuch.body.error).toMatch(/no pueden llegar más/)

    const res = await request(app).post(`/transfers/${t.id}/receive`).set(branchClerk.auth).send({ items: [{ itemId: t.items[0].id, receivedQuantity: 18 }] })
    expect(res.body).toMatchObject({ status: "RECEIVED", receivedBy: { id: branchClerk.user.id } })
    expect(res.body.items[0].receivedQuantity).toBe(18)
    expect(await stockAt(main)).toBe(18)
    expect(await total()).toBe(48) // 2 se perdieron en el camino

    const notes = (await request(app).get("/notifications").set(warehouseClerk.auth)).body.notifications
    expect(notes.find((n: { type: string }) => n.type === "transferReceived")).toMatchObject({ meta: { shortages: 1 } })
    // ya recibida: no se recibe ni se cancela otra vez
    expect((await request(app).post(`/transfers/${t.id}/receive`).set(branchClerk.auth)).status).toBe(400)
    expect((await request(app).post(`/transfers/${t.id}/cancel`).set(admin.auth)).status).toBe(400)
  })

  it("cancelar devuelve todo al origen; solo quien envió, el encargado o el admin", async () => {
    const t = (await send(warehouseClerk, { toLocationId: main, items: [{ productId, quantity: 10 }] })).body
    expect(await stockAt(bodega)).toBe(20)
    expect((await request(app).post(`/transfers/${t.id}/cancel`).set(branchClerk.auth)).status).toBe(403)
    const res = await request(app).post(`/transfers/${t.id}/cancel`).set(warehouseClerk.auth)
    expect(res.body.status).toBe("CANCELLED")
    expect(await stockAt(bodega)).toBe(30)
    expect(await total()).toBe(48)
  })

  it("cada uno ve las transferencias de sus ubicaciones; no cuentan como despacho", async () => {
    const other = await createUser("ADMIN")
    expect((await request(app).get("/transfers").set(other.auth)).body.total).toBe(0)
    expect((await request(app).get("/transfers").set(warehouseClerk.auth)).body.total).toBe(2)
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const dash = (await request(app).get(`/reports/dashboard?since=${since}`).set(admin.auth)).body
    expect(dash.dispatchedSince).toBe(0)
    // con una transferencia en tránsito la bodega no se puede desactivar
    await send(warehouseClerk, { toLocationId: main, items: [{ productId, quantity: 1 }] })
    await prisma.productStock.updateMany({ where: { locationId: bodega }, data: { quantity: 0 } })
    expect((await request(app).patch(`/locations/${bodega}`).set(admin.auth).send({ isActive: false })).body.error).toMatch(/tránsito/)
  })
})

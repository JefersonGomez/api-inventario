// Bloque 5A: recepción en partes, cancelar y cerrar órdenes de compra
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Órdenes de compra: recepción en partes, cancelar y cerrar", () => {
  let admin: User, employee: User
  let supplierId: string, nailsId: string, glueId: string
  const total = async (id: string) => Number((await prisma.product.findUniqueOrThrow({ where: { id } })).stock)
  const newOrder = (items: object[], extra: object = {}) =>
    request(app).post("/purchase-orders").set(admin.auth).send({ supplierId, items, ...extra })
  const receive = (id: string, items?: object[]) =>
    request(app).patch(`/purchase-orders/${id}/receive`).set(admin.auth).send(items ? { items } : undefined)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    employee = await createUser("EMPLOYE", admin.companyId)
    const c = admin.companyId
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    supplierId = (await prisma.supplier.create({ data: { companyId: c, name: "Proveedor" } })).id
    const create = (sku: string) =>
      request(app).post("/products").set(admin.auth).send({ sku, name: sku, price: 100, stock: 0, minStock: 0, categoryId: category.id })
    nailsId = (await create("CLAVOS")).body.id
    glueId = (await create("PEGA")).body.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("se recibe en partes: queda Parcial hasta completar y cada parte entra al stock", async () => {
    const order = (await newOrder([{ productId: nailsId, quantity: 10, unitCost: 50 }, { productId: glueId, quantity: 4, unitCost: 20 }])).body
    const [nails, glue] = [order.items.find((i: { productId: string }) => i.productId === nailsId), order.items.find((i: { productId: string }) => i.productId === glueId)]

    const first = await receive(order.id, [{ itemId: nails.id, quantity: 6 }])
    expect(first.body.status).toBe("PARTIAL")
    expect(first.body.items.find((i: { id: string }) => i.id === nails.id).receivedQuantity).toBe(6)
    expect(await total(nailsId)).toBe(6)
    expect(await total(glueId)).toBe(0)

    // no se recibe más de lo que falta, ni algo que no llegó
    expect((await receive(order.id, [{ itemId: nails.id, quantity: 5 }])).body.error).toMatch(/solo faltan 4/)
    expect((await receive(order.id, [{ itemId: nails.id, quantity: 0 }])).body.error).toMatch(/Indica qué llegó/)

    // sin indicar líneas: llega todo lo pendiente
    const rest = await receive(order.id)
    expect(rest.body.status).toBe("RECEIVED")
    expect(await total(nailsId)).toBe(10)
    expect(await total(glueId)).toBe(4)
    const moves = await prisma.stockMovement.count({ where: { source: "PURCHASE_RECEIPT", sourceId: order.id } })
    expect(moves).toBe(3) // 6 clavos, luego 4 clavos + 4 pega
    expect((await receive(order.id)).status).toBe(400)
  })

  it("cerrar una orden parcial cancela lo pendiente y conserva lo recibido", async () => {
    const order = (await newOrder([{ productId: nailsId, quantity: 8, unitCost: 50 }])).body
    expect((await request(app).post(`/purchase-orders/${order.id}/close`).set(admin.auth)).status).toBe(400) // nada recibido: se cancela, no se cierra
    await receive(order.id, [{ itemId: order.items[0].id, quantity: 3 }])
    const closed = await request(app).post(`/purchase-orders/${order.id}/close`).set(admin.auth).send({ reason: "El proveedor no tiene más" })
    expect(closed.body).toMatchObject({ status: "CLOSED", cancelReason: "El proveedor no tiene más" })
    expect(await total(nailsId)).toBe(13)
    expect((await receive(order.id)).status).toBe(400)
  })

  it("cancelar solo si no llegó nada; las solicitudes vuelven a quedar sin orden", async () => {
    const req = await request(app).post("/purchase-requests").set(employee.auth).send({ productId: glueId, quantity: 2 })
    await request(app).patch(`/purchase-requests/${req.body.id}/status`).set(admin.auth).send({ status: "APPROVED" })
    const order = (await newOrder([{ productId: glueId, quantity: 2, unitCost: 20 }], { fulfilledRequestIds: [req.body.id] })).body

    expect((await request(app).post(`/purchase-orders/${order.id}/cancel`).set(admin.auth).send({})).status).toBe(400) // motivo obligatorio
    const cancelled = await request(app).post(`/purchase-orders/${order.id}/cancel`).set(admin.auth).send({ reason: "Pedido duplicado" })
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", cancelReason: "Pedido duplicado" })
    const linked = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: req.body.id } })
    expect(linked.purchaseOrderId).toBeNull()
    expect((await request(app).get("/purchase-requests?unlinked=1").set(admin.auth)).body.items.map((r: { id: string }) => r.id)).toContain(req.body.id)
    expect((await receive(order.id)).status).toBe(400)

    // con algo recibido ya no se cancela (se cierra)
    const partial = (await newOrder([{ productId: glueId, quantity: 5, unitCost: 20 }])).body
    await receive(partial.id, [{ itemId: partial.items[0].id, quantity: 1 }])
    expect((await request(app).post(`/purchase-orders/${partial.id}/cancel`).set(admin.auth).send({ reason: "x" })).body.error).toMatch(/ciérrala/)
    expect((await request(app).post(`/purchase-orders/${partial.id}/cancel`).set(employee.auth).send({ reason: "x" })).status).toBe(403)
  })
})

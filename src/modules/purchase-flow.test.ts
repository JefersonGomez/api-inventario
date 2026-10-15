// Flujo de compra completo + reglas de acceso de solicitudes, órdenes y comentarios
import request from "supertest"
import app from "../app.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { resetDb, createUser } from "../test/helpers.ts"

describe("Flujo de compra", () => {
  let admin: Awaited<ReturnType<typeof createUser>>
  let employee: Awaited<ReturnType<typeof createUser>>
  let otherEmployee: Awaited<ReturnType<typeof createUser>>
  let productId: string
  let supplierId: string

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    employee = await createUser("EMPLOYE", admin.companyId)
    otherEmployee = await createUser("EMPLOYE", admin.companyId)
    const companyId = admin.companyId
    const category = await prisma.category.create({ data: { name: "Cat flujo", companyId } })
    const supplier = await prisma.supplier.create({ data: { name: "Proveedor flujo", email: "prov@test.com", companyId } })
    supplierId = supplier.id
    const product = await prisma.product.create({
      data: { companyId, sku: "FLOW-1", name: "Producto flujo", price: 100, stock: 5, minStock: 2, categoryId: category.id, supplierId },
    })
    productId = product.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("solicitud → aprobación → orden → recepción sube el stock y avisa a quien pidió", async () => {
    const created = await request(app).post("/purchase-requests").set(employee.auth).send({ productId, quantity: 10 })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe("PENDING")
    const requestId = created.body.id

    // aprobar no sube stock
    const approved = await request(app).patch(`/purchase-requests/${requestId}/status`).set(admin.auth).send({ status: "APPROVED" })
    expect(approved.status).toBe(200)
    expect(Number((await prisma.product.findUnique({ where: { id: productId } }))!.stock)).toBe(5)

    const order = await request(app).post("/purchase-orders").set(admin.auth).send({
      supplierId,
      items: [{ productId, quantity: 10, unitCost: 80 }],
      fulfilledRequestIds: [requestId],
    })
    expect(order.status).toBe(201)

    const received = await request(app).patch(`/purchase-orders/${order.body.id}/receive`).set(admin.auth)
    expect(received.status).toBe(200)
    expect(received.body.status).toBe("RECEIVED")
    expect(Number((await prisma.product.findUnique({ where: { id: productId } }))!.stock)).toBe(15)

    // recibir dos veces no vuelve a sumar
    expect((await request(app).patch(`/purchase-orders/${order.body.id}/receive`).set(admin.auth)).status).toBe(400)
    expect(Number((await prisma.product.findUnique({ where: { id: productId } }))!.stock)).toBe(15)

    const types = (await prisma.notification.findMany({ where: { userId: employee.user.id } })).map((n) => n.type)
    expect(types).toEqual(expect.arrayContaining(["requestApproved", "orderReceived"]))
  })

  it("rechazar exige motivo y el empleado no puede aprobar", async () => {
    const { body } = await request(app).post("/purchase-requests").set(employee.auth).send({ productId, quantity: 1 })
    expect((await request(app).patch(`/purchase-requests/${body.id}/status`).set(admin.auth).send({ status: "REJECTED" })).status).toBe(400)
    expect((await request(app).patch(`/purchase-requests/${body.id}/status`).set(employee.auth).send({ status: "APPROVED" })).status).toBe(403)
    const rejected = await request(app)
      .patch(`/purchase-requests/${body.id}/status`)
      .set(admin.auth)
      .send({ status: "REJECTED", rejectionReason: "Sin presupuesto" })
    expect(rejected.status).toBe(200)
    expect(rejected.body.rejectionReason).toBe("Sin presupuesto")
  })

  it("cada empleado ve solo sus solicitudes", async () => {
    const mine = await request(app).get("/purchase-requests").set(otherEmployee.auth)
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ items: [], total: 0 })
  })

  it("comentarios: quien pidió y admins sí; otro empleado no; órdenes solo admins", async () => {
    const { body: req } = await request(app).post("/purchase-requests").set(employee.auth).send({ productId, quantity: 2 })
    const url = `/purchase-requests/${req.id}/comments`

    expect((await request(app).post(url).set(employee.auth).send({ body: "  " })).status).toBe(400)
    expect((await request(app).post(url).set(employee.auth).send({ body: "¿Para cuándo?" })).status).toBe(201)
    expect((await request(app).post(url).set(admin.auth).send({ body: "Esta semana" })).status).toBe(201)
    expect((await request(app).get(url).set(otherEmployee.auth)).status).toBe(404)

    const thread = await request(app).get(url).set(employee.auth)
    expect(thread.body.map((c: { body: string }) => c.body)).toEqual(["¿Para cuándo?", "Esta semana"])

    // el autor no se avisa a sí mismo
    const adminNotes = await prisma.notification.findMany({ where: { userId: admin.user.id, type: "requestComment" } })
    expect(adminNotes).toHaveLength(1)

    const order = await prisma.purchaseOrder.findFirstOrThrow()
    expect((await request(app).get(`/purchase-orders/${order.id}/comments`).set(employee.auth)).status).toBe(403)
  })

  it("rutas que estaban rotas: /products/expiring-soon y PUT /profile/me", async () => {
    expect((await request(app).get("/products/expiring-soon").set(admin.auth)).status).toBe(200)
    const updated = await request(app).put("/profile/me").set(admin.auth).send({ name: "Admin nuevo", email: admin.user.email })
    expect(updated.status).toBe(200)
    expect(updated.body.name).toBe("Admin nuevo")
  })
})

// Aislamiento entre empresas: la empresa A nunca puede ver ni tocar datos de la B.
// Si uno de estos tests falla, hay una fuga de datos entre clientes.
import request from "supertest"
import bcrypt from "bcrypt"
import app from "../app.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { runWithCompany } from "../shared/tenant.ts"
import { toolExecutors } from "./assistant/assistant.tools.ts"
import { resetDb, createUser } from "../test/helpers.ts"

type Ctx = Awaited<ReturnType<typeof createUser>> & {
  categoryId: string; productId: string; supplierId: string; requestId: string
}

async function seedCompany(label: string): Promise<Ctx> {
  const admin = await createUser("ADMIN")
  const companyId = admin.companyId
  const category = await prisma.category.create({ data: { companyId, name: "General" } })
  const supplier = await prisma.supplier.create({ data: { companyId, name: "Proveedor", email: `${label}@prov.com` } })
  // mismo SKU en las dos empresas: la unicidad es por empresa
  const product = await prisma.product.create({
    data: { companyId, sku: "SKU-1", name: `Producto ${label}`, price: 10, stock: 0, minStock: 5, categoryId: category.id, supplierId: supplier.id },
  })
  const req = await prisma.purchaseRequest.create({
    data: { companyId, productId: product.id, requestedById: admin.user.id, quantity: 3, status: "APPROVED" },
  })
  return { ...admin, categoryId: category.id, productId: product.id, supplierId: supplier.id, requestId: req.id }
}

describe("Aislamiento entre empresas", () => {
  let A: Ctx
  let B: Ctx

  beforeAll(async () => {
    await resetDb()
    A = await seedCompany("A")
    B = await seedCompany("B")
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cada empresa lista solo lo suyo (productos, categorías, proveedores, solicitudes)", async () => {
    for (const path of ["/products", "/categories", "/suppliers", "/purchase-requests"]) {
      const res = await request(app).get(path).set(A.auth)
      expect(res.status).toBe(200)
      // los listados paginados responden { items, total }; categorías y proveedores (sin page), un arreglo
      const list = Array.isArray(res.body) ? res.body : res.body.items
      expect(list).toHaveLength(1)
      if (!Array.isArray(res.body)) expect(res.body.total).toBe(1)
      expect(JSON.stringify(res.body)).not.toContain(B.companyId)
    }
    const products = await request(app).get("/products").set(A.auth)
    expect(products.body.items[0].name).toBe("Producto A")
  })

  it("no puede leer, editar ni borrar por id un registro de otra empresa", async () => {
    const get = await request(app).get(`/products/${B.productId}`).set(A.auth)
    expect(get.body?.id).not.toBe(B.productId)
    const put = await request(app).put(`/products/${B.productId}`).set(A.auth)
      .send({ name: "hack", price: 1, minStock: 0, categoryId: A.categoryId })
    expect(put.status).toBeGreaterThanOrEqual(400)
    expect((await request(app).delete(`/products/${B.productId}`).set(A.auth)).status).toBeGreaterThanOrEqual(400)
    expect((await request(app).delete(`/suppliers/${B.supplierId}`).set(A.auth)).status).toBeGreaterThanOrEqual(400)

    const untouched = await prisma.product.findUniqueOrThrow({ where: { id: B.productId } })
    expect(untouched.name).toBe("Producto B")
    expect(untouched.deletedAt).toBeNull()
  })

  it("no puede referenciar datos de otra empresa al crear", async () => {
    const product = await request(app).post("/products").set(A.auth)
      .send({ sku: "X-1", name: "X", price: 1, stock: 0, minStock: 0, categoryId: B.categoryId })
    expect(product.status).toBe(400)

    const movement = await request(app).post("/movements").set(A.auth).send({ productId: B.productId, type: "IN", quantity: 5 })
    expect(movement.status).toBeGreaterThanOrEqual(400)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: B.productId } })).stock)).toBe(0)

    const order = await request(app).post("/purchase-orders").set(A.auth)
      .send({ supplierId: A.supplierId, items: [{ productId: B.productId, quantity: 1, unitCost: 1 }] })
    expect(order.status).toBe(400)
    const linked = await request(app).post("/purchase-orders").set(A.auth).send({
      supplierId: A.supplierId,
      items: [{ productId: A.productId, quantity: 1, unitCost: 1 }],
      fulfilledRequestIds: [B.requestId],
    })
    expect(linked.status).toBe(400)
  })

  it("comentarios, avisos y auditoría quedan dentro de cada empresa", async () => {
    expect((await request(app).get(`/purchase-requests/${B.requestId}/comments`).set(A.auth)).status).toBe(404)
    expect((await request(app).post(`/purchase-requests/${B.requestId}/comments`).set(A.auth).send({ body: "hola" })).status).toBe(404)

    // los dos productos tienen stock bajo; A solo ve el suyo
    const notes = await request(app).get("/notifications").set(A.auth)
    const lowStock = notes.body.notifications.filter((n: { type: string }) => n.type === "lowStock")
    expect(lowStock.map((n: { title: string }) => n.title)).toEqual(["Producto A"])

    await request(app).put("/company").set(B.auth).send({ name: "Empresa B renombrada" })
    const audit = await request(app).get("/audit-logs").set(A.auth)
    expect(audit.body.items.every((l: { companyId: string }) => l.companyId === A.companyId)).toBe(true)
    expect((await request(app).get("/company").set(A.auth)).body.name).not.toBe("Empresa B renombrada")
  })

  it("el asistente IA solo consulta datos de su empresa", async () => {
    const products = (await runWithCompany(A.companyId, () => toolExecutors.searchProducts!({}))) as { items: { name: string }[] }
    expect(products.items.map((p) => p.name)).toEqual(["Producto A"])
  })

  it("los usuarios de la empresa B no aparecen en la gestión de A ni se pueden desactivar", async () => {
    const users = await request(app).get("/users").set(A.auth)
    expect(users.body.map((u: { id: string }) => u.id)).toEqual([A.user.id])
    expect((await request(app).patch(`/users/${B.user.id}/toggle-active`).set(A.auth)).status).toBe(400)
  })
})

describe("Sesión, cambio de empresa y planes", () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("login devuelve la empresa activa y sus empresas; el refresh conserva la empresa", async () => {
    const owner = await createUser("ADMIN")
    await prisma.user.update({ where: { id: owner.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
    const login = await request(app).post("/auth/login").send({ email: owner.user.email, password: "Clave-segura-1" })
    expect(login.status).toBe(200)
    expect(login.body.company.id).toBe(owner.companyId)
    expect(login.body.user.role).toBe("ADMIN")
    expect(login.body.companies).toHaveLength(1)

    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: login.body.refreshToken })
    expect(refreshed.status).toBe(200)
    const me = await request(app).get("/auth/me").set({ Authorization: `Bearer ${refreshed.body.token}` })
    expect(me.body.user.companyId).toBe(owner.companyId)
  })

  it("un usuario en dos empresas cambia entre ellas; a una ajena no puede", async () => {
    const A = await createUser("ADMIN")
    const B = await createUser("ADMIN")
    await prisma.membership.create({ data: { userId: A.user.id, companyId: B.companyId, role: "EMPLOYE" } })

    const switched = await request(app).post("/auth/switch-company").set(A.auth).send({ companyId: B.companyId })
    expect(switched.status).toBe(200)
    expect(switched.body.user.role).toBe("EMPLOYE") // el rol es por empresa
    const me = await request(app).get("/auth/me").set({ Authorization: `Bearer ${switched.body.token}` })
    expect(me.body.user).toMatchObject({ companyId: B.companyId, role: "EMPLOYE" })

    const C = await createUser("ADMIN")
    expect((await request(app).post("/auth/switch-company").set(A.auth).send({ companyId: C.companyId })).status).toBe(403)
  })

  it("desactivar a alguien en la empresa corta su acceso al instante", async () => {
    const admin = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", admin.companyId)
    expect((await request(app).get("/products").set(emp.auth)).status).toBe(200)
    expect((await request(app).patch(`/users/${emp.user.id}/toggle-active`).set(admin.auth)).status).toBe(200)
    expect((await request(app).get("/products").set(emp.auth)).status).toBe(401)
  })

  it("registrarse crea una empresa nueva y vacía", async () => {
    await createUser("ADMIN") // otra empresa con datos
    const reg = await request(app).post("/auth/register").send({ acceptTerms: true, name: "Nueva", email: "nueva@test.com", password: "Clave-segura-1", company: "Ferretería Nueva" })
    expect(reg.status).toBe(201)
    const login = await request(app).post("/auth/login").send({ email: "nueva@test.com", password: "Clave-segura-1" })
    expect(login.body.company.name).toBe("Ferretería Nueva")
    const products = await request(app).get("/products").set({ Authorization: `Bearer ${login.body.token}` })
    expect(products.body).toMatchObject({ items: [], total: 0 })
  })

  it("el plan limita cuántas empresas se pueden crear", async () => {
    const basic = await createUser("ADMIN")
    const extra = await request(app).post("/companies").set(basic.auth).send({ name: "Segunda" })
    expect(extra.status).toBe(400) // BASIC = 1 empresa

    await prisma.user.update({ where: { id: basic.user.id }, data: { plan: "PRO" } })
    expect((await request(app).post("/companies").set(basic.auth).send({ name: "Segunda" })).status).toBe(201)
    const mine = await request(app).get("/companies").set(basic.auth)
    expect(mine.body.map((c: { name: string }) => c.name)).toContain("Segunda")
  })

  it("el plan limita la cantidad de productos", async () => {
    const admin = await createUser("ADMIN")
    const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "C" } })
    await prisma.product.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        companyId: admin.companyId, sku: `P-${i}`, name: `P${i}`, price: 1, stock: 0, minStock: 0, categoryId: category.id,
      })),
    })
    const over = await request(app).post("/products").set(admin.auth)
      .send({ sku: "P-500", name: "Uno más", price: 1, stock: 0, minStock: 0, categoryId: category.id })
    expect(over.status).toBe(400)
    expect(over.body.error).toContain("500")
  })
})

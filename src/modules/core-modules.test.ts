// Bloque 12: cobertura de los módulos que no tenían tests (categorías, proveedores, reportes de
// movimientos y pronóstico, notificaciones, auditoría y el contrato de solo lectura del asistente)
import request from "supertest"
import app from "../app.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../test/helpers.ts"
import { toolDeclarations, toolExecutors } from "./assistant/assistant.tools.ts"

type User = Awaited<ReturnType<typeof createUser>>

let admin: User
let employee: User

beforeAll(async () => {
  await resetDb()
  admin = await createUser("ADMIN")
  employee = await createUser("EMPLOYE", admin.companyId)
})

afterAll(async () => {
  await resetDb()
  await prisma.$disconnect()
})

// producto con stock en la ubicación principal (como lo deja la app)
async function product(name: string, stock: number, minStock = 0) {
  const category = await prisma.category.create({ data: { companyId: admin.companyId, name: `Cat ${name}` } })
  const p = await prisma.product.create({ data: { companyId: admin.companyId, sku: name.toUpperCase(), name, price: 100, stock, minStock, categoryId: category.id } })
  await prisma.productStock.create({ data: { companyId: admin.companyId, productId: p.id, locationId: await mainLocationId(admin.companyId), quantity: stock } })
  return p
}

describe("Categorías", () => {
  it("crea, no repite nombre, edita con auditoría y el borrado es lógico y libera el nombre", async () => {
    const created = await request(app).post("/categories").set(admin.auth).send({ name: "Herramientas" })
    expect(created.status).toBe(201)
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Herramientas" })).status).toBe(400)

    const id = created.body.id
    expect((await request(app).put(`/categories/${id}`).set(admin.auth).send({ name: "Herramientas manuales" })).body.name).toBe("Herramientas manuales")
    expect(await prisma.auditLog.count({ where: { entityType: "Category", entityId: id, action: "UPDATE" } })).toBe(1)

    expect((await request(app).delete(`/categories/${id}`).set(admin.auth)).status).toBe(200)
    expect((await request(app).get(`/categories/${id}`).set(admin.auth)).status).toBe(400)
    expect(await prisma.category.findUnique({ where: { id } })).toMatchObject({ deletedAt: expect.any(Date) })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Herramientas manuales" })).status).toBe(201)
  })

  it("el empleado las lee pero no las cambia", async () => {
    expect((await request(app).get("/categories").set(employee.auth)).status).toBe(200)
    expect((await request(app).post("/categories").set(employee.auth).send({ name: "X" })).status).toBe(403)
  })
})

describe("Proveedores", () => {
  it("crea, busca, no repite nombre y no se borra si tiene productos", async () => {
    const res = await request(app).post("/suppliers").set(admin.auth).send({ name: "Ferretera del Valle", email: "ventas@valle.test" })
    expect(res.status).toBe(201)
    expect((await request(app).post("/suppliers").set(admin.auth).send({ name: "Ferretera del Valle" })).status).toBe(400)
    expect((await request(app).post("/suppliers").set(admin.auth).send({ name: "Mal", email: "no-es-correo" })).status).toBe(400)

    const page = await request(app).get("/suppliers?page=1&q=valle").set(admin.auth)
    expect(page.body).toMatchObject({ total: 1, items: [{ name: "Ferretera del Valle" }] })

    const p = await product("Martillo", 5)
    await prisma.product.update({ where: { id: p.id }, data: { supplierId: res.body.id } })
    expect((await request(app).delete(`/suppliers/${res.body.id}`).set(admin.auth)).status).toBe(400)
    expect((await request(app).get(`/suppliers/${res.body.id}`).set(admin.auth)).status).toBe(200)

    const free = await request(app).post("/suppliers").set(admin.auth).send({ name: "Sin productos" })
    expect((await request(app).delete(`/suppliers/${free.body.id}`).set(employee.auth)).status).toBe(403)
    expect((await request(app).delete(`/suppliers/${free.body.id}`).set(admin.auth)).status).toBe(200)
  })
})

describe("Reportes de movimientos y pronóstico", () => {
  it("el rango \"hasta hoy\" incluye los movimientos de hoy y rechaza fechas inválidas", async () => {
    const p = await product("Clavos", 100)
    expect((await request(app).post("/movements").set(admin.auth).send({ productId: p.id, type: "OUT", quantity: 3, reason: "Uso" })).status).toBe(201)

    const today = new Date().toLocaleDateString("sv")
    const res = await request(app).get(`/reports/movements?from=${today}&to=${today}`).set(employee.auth)
    expect(res.status).toBe(200)
    expect((res.body as { productId: string }[]).some((m) => m.productId === p.id)).toBe(true)
    expect((await request(app).get("/reports/movements?to=ayer").set(admin.auth)).status).toBe(400)
  })

  it("el pronóstico calcula la velocidad con las salidas y marca lo urgente", async () => {
    const p = await product("Tornillos", 40)
    // 30 salidas en 30 días = 1 por día; con 10 de stock quedan 10 días (< 14 → urgente)
    await request(app).post("/movements").set(admin.auth).send({ productId: p.id, type: "OUT", quantity: 30, reason: "Ventas" })
    const res = await request(app).get("/reports/stock-forecast").set(admin.auth)
    const row = (res.body.forecast as { productId: string }[]).find((f) => f.productId === p.id)
    expect(row).toMatchObject({ currentStock: 10, dailyVelocity: 1, daysRemaining: 10, willRunOutSoon: true })
    expect((res.body.urgent as { productId: string }[]).map((f) => f.productId)).toContain(p.id)
  })
})

describe("Notificaciones", () => {
  it("el stock bajo le avisa a quien gestiona compras, no al empleado", async () => {
    const p = await product("Lija", 1, 5)
    const mine = await request(app).get("/notifications").set(admin.auth)
    expect((mine.body.notifications as { id: string }[]).map((n) => n.id)).toContain(`product-lowstock-${p.id}`)
    const theirs = await request(app).get("/notifications").set(employee.auth)
    expect((theirs.body.notifications as { type: string }[]).some((n) => n.type === "lowStock")).toBe(false)
  })

  it("los avisos guardados se marcan como leídos solo por su dueño", async () => {
    const n = await prisma.notification.create({ data: { companyId: admin.companyId, userId: employee.user.id, type: "approved", title: "Lija", link: "/purchase-requests" } })
    expect((await request(app).patch(`/notifications/${n.id}/read`).set(admin.auth)).body).toEqual({ updated: 0 })
    expect((await request(app).get("/notifications").set(employee.auth)).body.unread).toBe(1)
    expect((await request(app).patch(`/notifications/${n.id}/read`).set(employee.auth)).body).toEqual({ updated: 1 })
    expect((await request(app).get("/notifications").set(employee.auth)).body.unread).toBe(0)
  })
})

describe("Auditoría", () => {
  it("lista paginada con filtros y métricas, solo para quien tiene audit.view", async () => {
    const list = await request(app).get("/audit-logs?entityType=Category&action=UPDATE").set(admin.auth)
    expect(list.status).toBe(200)
    expect(list.body.total).toBeGreaterThanOrEqual(1)
    expect((list.body.items as { entityType: string }[]).every((l) => l.entityType === "Category")).toBe(true)
    expect((await request(app).get("/audit-logs/metrics").set(admin.auth)).body.totalCount).toBeGreaterThanOrEqual(1)
    expect((await request(app).get("/audit-logs").set(employee.auth)).status).toBe(403)
  })

  it("no se ve la auditoría de otra empresa", async () => {
    const other = await createUser("ADMIN")
    const cat = await request(app).post("/categories").set(other.auth).send({ name: "Ajena" })
    await request(app).put(`/categories/${cat.body.id}`).set(other.auth).send({ name: "Ajena 2" })
    const list = await request(app).get("/audit-logs?entityType=Category").set(admin.auth)
    expect((list.body.items as { entityId: string }[]).map((l) => l.entityId)).not.toContain(cat.body.id)
  })
})

describe("Asistente IA", () => {
  it("solo tiene herramientas de lectura y cada una declarada tiene su ejecutor", () => {
    const names = toolDeclarations.map((t) => t.name)
    expect(names.sort()).toEqual(Object.keys(toolExecutors).sort())
    // nombres de consulta: get*/search*; una herramienta create/update/delete rompería la regla de solo lectura
    for (const name of names) expect(name).toMatch(/^(get|search)[A-Z]/)
  })

  it("valida el mensaje antes de llamar a Gemini", async () => {
    expect((await request(app).post("/assistant/chat").set(admin.auth).send({ message: "" })).status).toBe(400)
  })
})

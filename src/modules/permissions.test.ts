// Bloque 3: roles fijos + ajustes por persona + PIN de autorización
import request from "supertest"
import bcrypt from "bcrypt"
import app from "../app.ts"
import { resetDb, createUser } from "../test/helpers.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { PERMISSIONS, effectivePermissions } from "../config/permissions.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Roles, permisos y PIN de autorización", () => {
  let admin: User, manager: User, warehouse: User, cashier: User, accountant: User
  let categoryId: string
  let productId: string

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    manager = await createUser("MANAGER", c)
    warehouse = await createUser("EMPLOYE", c)
    cashier = await createUser("CASHIER", c)
    accountant = await createUser("ACCOUNTANT", c)
    categoryId = (await prisma.category.create({ data: { companyId: c, name: "General" } })).id
    productId = (await prisma.product.create({ data: { companyId: c, sku: "P1", name: "Martillo", price: 5000, cost: 3100, stock: 10, minStock: 2, categoryId } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("el administrador tiene todo y no se le puede quitar nada; los ajustes suman y restan sobre el rol", () => {
    expect(effectivePermissions("ADMIN", [], ["users.manage"])).toEqual([...PERMISSIONS])
    const cashierPlus = effectivePermissions("CASHIER", ["products.manage", "inventado"], ["sales.sell"])
    expect(cashierPlus).toContain("products.manage")
    expect(cashierPlus).not.toContain("sales.sell")
    expect(cashierPlus).not.toContain("inventado")
  })

  it("/auth/me trae los permisos efectivos y si tiene PIN", async () => {
    const me = (await request(app).get("/auth/me").set(cashier.auth)).body.user
    expect(me).toMatchObject({ role: "CASHIER", hasPin: false })
    expect(me.permissions).toEqual(expect.arrayContaining(["sales.sell", "customers.manage"]))
    expect(me.permissions).not.toContain("costs.view")
  })

  it("cajero: registra clientes y pide mercadería, pero no ve costos ni edita productos, stock, reportes u órdenes", async () => {
    expect((await request(app).post("/customers").set(cashier.auth).send({ name: "Cliente caja" })).status).toBe(201)
    expect((await request(app).post("/purchase-requests").set(cashier.auth).send({ productId, quantity: 1 })).status).toBe(201)
    expect((await request(app).post("/products").set(cashier.auth).send({ sku: "X", name: "X", price: 1, stock: 0, minStock: 0, categoryId })).status).toBe(403)
    expect((await request(app).post("/movements").set(cashier.auth).send({ productId, type: "IN", quantity: 1 })).status).toBe(403)
    expect((await request(app).get("/reports/low-stock").set(cashier.auth)).status).toBe(403)
    expect((await request(app).get("/purchase-orders").set(cashier.auth)).status).toBe(403)
    expect((await request(app).post("/assistant/chat").set(cashier.auth).send({ message: "hola" })).status).toBe(403)

    // los costos se quitan de TODA respuesta: lista, detalle y el producto dentro de una solicitud
    const list = (await request(app).get("/products").set(cashier.auth)).body.items
    expect(list[0]).not.toHaveProperty("cost")
    expect(list[0].price).toBe(5000)
    expect((await request(app).get(`/products/${productId}`).set(cashier.auth)).body).not.toHaveProperty("cost")
    const req = (await request(app).get("/purchase-requests").set(cashier.auth)).body.items[0]
    expect(req.product).not.toHaveProperty("cost")
  })

  it("bodega (EMPLOYE) conserva lo de antes; las órdenes de compra ya no se ven por la API", async () => {
    expect((await request(app).get("/products").set(warehouse.auth)).body.items[0].cost).toBe(3100)
    expect((await request(app).post("/movements").set(warehouse.auth).send({ productId, type: "IN", quantity: 1 })).status).toBe(201)
    expect((await request(app).get("/reports/inventory-value").set(warehouse.auth)).status).toBe(200)
    expect((await request(app).post("/products").set(warehouse.auth).send({ sku: "Y", name: "Y", price: 1, stock: 0, minStock: 0, categoryId })).status).toBe(403)
    // antes solo pedía sesión: la pantalla estaba oculta pero la API daba las órdenes con sus costos
    expect((await request(app).get("/purchase-orders").set(warehouse.auth)).status).toBe(403)
  })

  it("encargado: productos, compras y auditoría sí; usuarios y datos de la empresa no", async () => {
    expect((await request(app).post("/products").set(manager.auth).send({ sku: "M1", name: "Del encargado", price: 10, stock: 0, minStock: 0, categoryId })).status).toBe(201)
    expect((await request(app).get("/purchase-orders").set(manager.auth)).status).toBe(200)
    expect((await request(app).get("/audit-logs").set(manager.auth)).status).toBe(200)
    expect((await request(app).get("/users").set(manager.auth)).status).toBe(403)
    expect((await request(app).put("/company").set(manager.auth).send({ name: "Otra" })).status).toBe(403)
    // ve todas las solicitudes (no solo las suyas), como quien gestiona compras
    expect((await request(app).get("/purchase-requests").set(manager.auth)).body.total).toBeGreaterThanOrEqual(1)
  })

  it("contador: reportes y valor a costo, solo lectura", async () => {
    expect((await request(app).get("/reports/inventory-value").set(accountant.auth)).status).toBe(200)
    expect((await request(app).get("/audit-logs").set(accountant.auth)).status).toBe(200)
    expect((await request(app).post("/customers").set(accountant.auth).send({ name: "No" })).status).toBe(403)
    expect((await request(app).post("/movements").set(accountant.auth).send({ productId, type: "IN", quantity: 1 })).status).toBe(403)
  })

  it("ajustes por persona: aplican al instante; nadie cambia su propio acceso; el dueño siempre es administrador", async () => {
    const access = (u: User, body: object, by: User = admin) => request(app).patch(`/users/${u.user.id}/access`).set(by.auth).send(body)

    // a la bodega se le quita ver costos → la siguiente petición ya no los trae
    const res = await access(warehouse, { role: "EMPLOYE", revokedPermissions: ["costs.view"] })
    expect(res.status).toBe(200)
    expect(res.body.revokedPermissions).toEqual(["costs.view"])
    expect((await request(app).get("/products").set(warehouse.auth)).body.items[0]).not.toHaveProperty("cost")

    // al cajero se le da editar productos
    await access(cashier, { role: "CASHIER", grantedPermissions: ["products.manage"] })
    expect((await request(app).post("/products").set(cashier.auth).send({ sku: "C1", name: "Del cajero", price: 1, stock: 0, minStock: 0, categoryId })).status).toBe(201)
    await access(cashier, { role: "CASHIER" })

    expect((await access(admin, { role: "MANAGER" })).status).toBe(400) // a sí mismo
    const other = await createUser("ADMIN", admin.companyId)
    expect((await access(admin, { role: "MANAGER" }, other)).body.error).toMatch(/dueño/)
    expect((await access(cashier, { role: "CASHIER", grantedPermissions: ["no.existe"] })).status).toBe(400)
    expect((await access(cashier, { role: "CASHIER", grantedPermissions: ["costs.view"], revokedPermissions: ["costs.view"] })).status).toBe(400)
    expect((await request(app).patch(`/users/${cashier.user.id}/access`).set(manager.auth).send({ role: "ADMIN" })).status).toBe(403)

    const log = await prisma.auditLog.findFirst({ where: { entityType: "UserAccess", entityId: warehouse.user.id } })
    expect(log).toBeTruthy()
    const catalog = (await request(app).get("/users/permissions").set(admin.auth)).body
    expect(catalog.rolePermissions.CASHIER).toContain("sales.sell")
  })

  it("PIN: solo quien autoriza lo define, con su contraseña y sin PIN obvio", async () => {
    await prisma.user.update({ where: { id: manager.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
    const setPin = (u: User, body: object) => request(app).put("/profile/me/pin").set(u.auth).send(body)
    expect((await setPin(cashier, { pin: "4821", password: "123456" })).body.error).toMatch(/no necesitas PIN/)
    expect((await setPin(manager, { pin: "4821", password: "mala" })).body.error).toMatch(/contraseña/)
    expect((await setPin(manager, { pin: "1234", password: "Clave-segura-1" })).status).toBe(400)
    expect((await setPin(manager, { pin: "12", password: "Clave-segura-1" })).status).toBe(400)
    expect((await setPin(manager, { pin: "4821", password: "Clave-segura-1" })).status).toBe(204)
    expect((await request(app).get("/auth/me").set(manager.auth)).body.user.hasPin).toBe(true)
    const stored = await prisma.membership.findFirstOrThrow({ where: { userId: manager.user.id } })
    expect(stored.pinHash).not.toContain("4821")
  })

  it("autorizar en la caja con el PIN del encargado: queda en auditoría quién autorizó", async () => {
    const ok = await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "sales.void", reason: "Anular venta" })
    expect(ok.status).toBe(200)
    expect(ok.body.authorizedBy).toMatchObject({ id: manager.user.id })
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "AUTHORIZE" } })
    expect(log).toMatchObject({ userId: manager.user.id, entityId: cashier.user.id })

    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "9999", permission: "sales.void" })).status).toBe(401)
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "users.manage" })).status).toBe(400)

    // si el encargado deja de poder autorizar, su PIN se borra
    await request(app).patch(`/users/${manager.user.id}/access`).set(admin.auth).send({ role: "MANAGER", revokedPermissions: ["sales.discount", "sales.void"] })
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: manager.user.id } })).pinHash).toBeNull()
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "sales.void" })).status).toBe(401)
  })

  it("el PIN tiene límite de intentos fallidos", async () => {
    process.env.RATE_LIMIT_OFF = "0"
    try {
      const statuses = []
      for (let i = 0; i < 6; i++) {
        statuses.push((await request(app).post("/authorizations").set(accountant.auth).send({ pin: "1111", permission: "sales.void" })).status)
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
      expect(statuses[5]).toBe(429)
    } finally {
      process.env.RATE_LIMIT_OFF = "1"
    }
  })

  it("comentarios y avisos de compras siguen al permiso, no al rol de administrador", async () => {
    const r = await request(app).post("/purchase-requests").set(warehouse.auth).send({ productId, quantity: 3 })
    // el encargado (sin ser ADMIN) ve y comenta la solicitud de otro
    expect((await request(app).get(`/purchase-requests/${r.body.id}/comments`).set(manager.auth)).status).toBe(200)
    expect((await request(app).get(`/purchase-requests/${r.body.id}/comments`).set(cashier.auth)).status).not.toBe(200)
    const notes = (await request(app).get("/notifications").set(manager.auth)).body.notifications
    expect(notes.some((n: { type: string }) => n.type === "pending")).toBe(true)
  })
})

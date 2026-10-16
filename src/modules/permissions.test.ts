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

  it("código de caja: lo genera el admin (o el encargado para cajeros) y se muestra una sola vez", async () => {
    const generate = (u: User, by: User) => request(app).post(`/users/${u.user.id}/pin`).set(by.auth)
    // el contador no abre caja ni autoriza
    expect((await generate(accountant, admin)).body.error).toMatch(/no necesita código/)
    // el cajero no genera códigos; el encargado no genera el de otro encargado
    expect((await generate(cashier, cashier)).status).toBe(403)
    const manager2 = await createUser("MANAGER", admin.companyId)
    expect((await generate(manager2, manager)).status).toBe(403)

    const byManager = await generate(cashier, manager)
    expect(byManager.status).toBe(201)
    expect(byManager.body.pin).toMatch(/^\d{6}$/)
    const stored = await prisma.membership.findFirstOrThrow({ where: { userId: cashier.user.id } })
    expect(stored.pinHash).not.toContain(byManager.body.pin)
    expect(stored.pinSetBySelf).toBe(false)
    expect((await request(app).get("/auth/me").set(cashier.auth)).body.user).toMatchObject({ hasPin: true, pinLockedUntil: null, pinExpired: false })
    const log = await prisma.auditLog.findFirst({ where: { entityType: "AuthorizationPin", entityId: cashier.user.id, userId: manager.user.id } })
    expect(log).toBeTruthy()
    // le llega un aviso de que le asignaron código
    const notes = (await request(app).get("/notifications").set(cashier.auth)).body.notifications
    expect(notes.find((n: { type: string }) => n.type === "cashCodeAssigned")).toMatchObject({ meta: { by: manager.user.name } })

    // también se puede elegir el código (con las mismas reglas)
    const fresh = await createUser("CASHIER", admin.companyId)
    expect((await request(app).post(`/users/${fresh.user.id}/pin`).set(admin.auth).send({ pin: "1111" })).status).toBe(400)
    expect((await request(app).post(`/users/${fresh.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body).toEqual({ pin: "5937" })

    // "Códigos del equipo": a quién puede asignarle cada uno
    const team = async (by: User) => (await request(app).get("/users/cash-codes").set(by.auth)).body.map((u: { id: string }) => u.id)
    const byManagerTeam = await team(manager)
    expect(byManagerTeam).toEqual(expect.arrayContaining([cashier.user.id, fresh.user.id]))
    expect(byManagerTeam).not.toContain(manager2.user.id)
    expect(byManagerTeam).not.toContain(accountant.user.id)
    expect(await team(admin)).toEqual(expect.arrayContaining([manager.user.id, manager2.user.id, cashier.user.id]))
    expect((await request(app).get("/users/cash-codes").set(cashier.auth)).status).toBe(403)
  })

  it("código de caja: la persona lo cambia una vez y queda fijo; si lo olvida, el admin genera otro", async () => {
    const setPin = (u: User, body: object) => request(app).put("/profile/me/pin").set(u.auth).send(body)
    // sin código generado no puede ponerse uno (salvo el admin)
    const freshCashier = await createUser("CASHIER", admin.companyId)
    expect((await setPin(freshCashier, { pin: "4821", password: "123456" })).body.error).toMatch(/Pide tu código/)
    expect((await setPin(accountant, { pin: "4821", password: "123456" })).body.error).toMatch(/no necesitas código/)

    expect((await setPin(cashier, { pin: "5937", password: "mala" })).body.error).toMatch(/contraseña/)
    expect((await setPin(cashier, { pin: "1234", password: "123456" })).status).toBe(400)
    expect((await setPin(cashier, { pin: "12", password: "123456" })).status).toBe(400)
    expect((await setPin(cashier, { pin: "5937", password: "123456" })).status).toBe(204)
    // ya lo cambió: queda fijo hasta que pase el plazo
    const locked = await setPin(cashier, { pin: "6048", password: "123456" })
    expect(locked.status).toBe(400)
    expect(locked.body.error).toMatch(/cuando venza/)
    const me = (await request(app).get("/auth/me").set(cashier.auth)).body.user
    expect(new Date(me.pinLockedUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    // ya no existe borrar el propio código (sería una forma de saltarse el plazo)
    expect((await request(app).delete("/profile/me/pin").set(cashier.auth)).status).toBe(404)

    // por vencer (últimos 5 días) → aviso; vencido → aviso y ya no sirve hasta renovarlo
    const ago = (days: number) => prisma.membership.updateMany({ where: { userId: cashier.user.id }, data: { pinSetAt: new Date(Date.now() - days * 86_400_000) } })
    const codeNotice = async () => (await request(app).get("/notifications").set(cashier.auth)).body.notifications.find((n: { id: string }) => n.id === "cash-code-expiry")?.type
    await ago(27)
    expect(await codeNotice()).toBe("cashCodeExpiring")
    // el plazo es configurable por empresa: con 60 días ya no está por vencer
    expect((await request(app).put("/company").set(admin.auth).send({ cashCodeDays: 3 })).status).toBe(400)
    expect((await request(app).put("/company").set(admin.auth).send({ cashCodeDays: 60 })).status).toBe(200)
    expect(await codeNotice()).toBeUndefined()
    await request(app).put("/company").set(admin.auth).send({ cashCodeDays: 30 })
    await ago(31)
    expect(await codeNotice()).toBe("cashCodeExpired")
    expect((await request(app).get("/auth/me").set(cashier.auth)).body.user).toMatchObject({ pinExpired: true, pinLockedUntil: null })

    // venció → puede renovarlo él mismo
    await prisma.membership.updateMany({ where: { userId: cashier.user.id }, data: { pinSetAt: new Date(Date.now() - 31 * 86_400_000) } })
    expect((await setPin(cashier, { pin: "6048", password: "123456" })).status).toBe(204)
    // lo olvidó → el admin genera otro y puede cambiarlo enseguida
    expect((await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth)).status).toBe(201)
    expect((await setPin(cashier, { pin: "7159", password: "123456" })).status).toBe(204)

    // el admin se pone el suyo sin que nadie se lo genere
    expect((await setPin(admin, { pin: "3826", password: "123456" })).status).toBe(204)
    // el encargado: se lo genera el admin y él lo cambia
    await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth)
    await prisma.user.update({ where: { id: manager.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
    expect((await setPin(manager, { pin: "4821", password: "Clave-segura-1" })).status).toBe(204)
  })

  it("autorizar en la caja con el PIN del encargado: queda en auditoría quién autorizó", async () => {
    const ok = await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "sales.void", reason: "Anular venta" })
    expect(ok.status).toBe(200)
    expect(ok.body.authorizedBy).toMatchObject({ id: manager.user.id })
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "AUTHORIZE" } })
    expect(log).toMatchObject({ userId: manager.user.id, entityId: cashier.user.id })

    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "9999", permission: "sales.void" })).status).toBe(401)
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "users.manage" })).status).toBe(400)
    // el código del cajero abre su caja, pero no autoriza
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "7159", permission: "sales.void" })).status).toBe(401)

    // código vencido: no autoriza hasta que se renueve
    await prisma.membership.updateMany({ where: { userId: manager.user.id }, data: { pinSetAt: new Date(Date.now() - 31 * 86_400_000) } })
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "sales.void" })).status).toBe(401)
    await prisma.membership.updateMany({ where: { userId: manager.user.id }, data: { pinSetAt: new Date() } })

    // sin permisos de autorizar ya no autoriza, pero conserva el código (sigue abriendo caja)
    await request(app).patch(`/users/${manager.user.id}/access`).set(admin.auth).send({ role: "MANAGER", revokedPermissions: ["sales.discount", "sales.void"] })
    expect((await request(app).post("/authorizations").set(cashier.auth).send({ pin: "4821", permission: "sales.void" })).status).toBe(401)
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: manager.user.id } })).pinHash).not.toBeNull()
    // si tampoco abre caja, el código ya no sirve y se borra
    await request(app).patch(`/users/${manager.user.id}/access`).set(admin.auth).send({ role: "MANAGER", revokedPermissions: ["sales.discount", "sales.void", "cash.manage"] })
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: manager.user.id } })).pinHash).toBeNull()
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

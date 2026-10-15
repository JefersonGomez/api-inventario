// Bloque 2: listados paginados, búsqueda y filtros en el servidor
import request from "supertest"
import app from "../app.ts"
import { resetDb, createUser } from "../test/helpers.ts"
import { prismaRoot as prisma } from "../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Paginación, búsqueda y filtros", () => {
  let admin: User
  let employee: User
  let catTools: string
  let catFood: string
  let groupId: string
  const get = (path: string, who: User = admin) => request(app).get(path).set(who.auth)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    employee = await createUser("EMPLOYE", admin.companyId)
    const companyId = admin.companyId
    catTools = (await prisma.category.create({ data: { companyId, name: "Herramientas" } })).id
    catFood = (await prisma.category.create({ data: { companyId, name: "Abarrotes" } })).id
    groupId = (await prisma.productGroup.create({ data: { companyId, name: "Camisa", attributeNames: ["Talla"] } })).id
    const p = (sku: string, name: string, extra: object = {}) =>
      prisma.product.create({ data: { companyId, sku, name, price: 1000, stock: 10, minStock: 2, categoryId: catTools, ...extra } })
    await p("MAR-1", "Martillo", { barcode: "7441000000017" })
    await p("DES-1", "Destornillador", { stock: 1 }) // bajo mínimo
    await p("ARR-1", "Arroz", { categoryId: catFood, pendingReview: true, price: 0 })
    await p("CLA-1", "Clavos", { unit: "KG", stock: 2.5, minStock: 3 }) // bajo mínimo
    await p("CAM-S", "Camisa S", { groupId, attributes: { Talla: "S" }, price: 9000, stock: 3, minStock: 1 })
    await p("CAM-M", "Camisa M", { groupId, attributes: { Talla: "M" }, price: 9500, stock: 1, minStock: 2 }) // bajo mínimo
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("productos: forma de la página, orden por nombre y validación de la query", async () => {
    const res = await get("/products?pageSize=2&page=2")
    expect(res.body).toMatchObject({ total: 6, page: 2, pageSize: 2, pageCount: 3 })
    expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(["Camisa S", "Clavos"])
    expect((await get("/products?pageSize=500")).status).toBe(400)
    expect((await get("/products?page=0")).status).toBe(400)
  })

  it("productos: búsqueda por nombre, SKU, código exacto y categoría; filtros bajo mínimo y por completar", async () => {
    const names = async (qs: string) => (await get(`/products?${qs}`)).body.items.map((p: { name: string }) => p.name)
    expect(await names("q=marti")).toEqual(["Martillo"])
    expect(await names("q=des-1")).toEqual(["Destornillador"])
    expect(await names("q=7441000000017")).toEqual(["Martillo"])
    expect(await names("q=abarro")).toEqual(["Arroz"])
    // stock <= mínimo comparando columnas (2,5 kg < 3 kg también cuenta)
    expect(await names("lowStock=1")).toEqual(["Camisa M", "Clavos", "Destornillador"])
    expect(await names("pending=1")).toEqual(["Arroz"])
    expect(await names(`categoryId=${catFood}`)).toEqual(["Arroz"])
    expect(await names(`groupId=${groupId}`)).toEqual(["Camisa M", "Camisa S"])
  })

  it("productos agrupados: primero el producto base con su resumen, después los sueltos, paginados juntos", async () => {
    const p1 = (await get("/products?view=grouped&pageSize=2")).body
    expect(p1).toMatchObject({ total: 5, pageCount: 3, pendingCount: 1 }) // 1 grupo + 4 sueltos
    expect(p1.items[0]).toMatchObject({
      kind: "group", name: "Camisa", variantCount: 2, minPrice: 9000, maxPrice: 9500, totalStock: 4, unit: "UNIT", lowCount: 1,
    })
    expect(p1.items[1]).toMatchObject({ kind: "product", name: "Arroz" })
    const p2 = (await get("/products?view=grouped&pageSize=2&page=2")).body
    expect(p2.items.map((i: { name: string }) => i.name)).toEqual(["Clavos", "Destornillador"])

    // con búsqueda: el grupo entra si alguna variante coincide o si coincide su nombre
    const byVariant = (await get("/products?view=grouped&q=CAM-M")).body.items
    expect(byVariant.map((i: { kind: string; name: string }) => `${i.kind}:${i.name}`)).toEqual(["group:Camisa"])
    const lowOnly = (await get("/products?view=grouped&lowStock=1")).body.items
    expect(lowOnly.map((i: { name: string }) => i.name)).toEqual(["Camisa", "Clavos", "Destornillador"])
    // un producto base sin variantes también aparece (antes no se veía en la tabla)
    await prisma.productGroup.create({ data: { companyId: admin.companyId, name: "Botas", attributeNames: ["Número"] } })
    const withEmpty = (await get("/products?view=grouped")).body.items
    expect(withEmpty[0]).toMatchObject({ kind: "group", name: "Botas", variantCount: 0, minPrice: null })
  })

  it("movimientos: más recientes primero, filtros por tipo, origen y texto", async () => {
    const productId = (await prisma.product.findFirstOrThrow({ where: { sku: "MAR-1" } })).id
    for (const type of ["IN", "OUT", "IN"] as const) {
      await request(app).post("/movements").set(admin.auth).send({ productId, type, quantity: 1, reason: `mov ${type}` })
    }
    const page = (await get("/movements?pageSize=2")).body
    expect(page).toMatchObject({ total: 3, pageCount: 2 })
    expect(page.items[0].type).toBe("IN") // el último registrado
    expect(page.items[0].product).toMatchObject({ name: "Martillo", unit: "UNIT" })
    expect((await get("/movements?type=OUT")).body.total).toBe(1)
    expect((await get("/movements?source=MANUAL&q=martillo")).body.total).toBe(3)
    expect((await get("/movements?q=nada")).body.total).toBe(0)
  })

  it("solicitudes: filtro por estado y 'sin orden'; el empleado ve solo las suyas, también por id", async () => {
    const productId = (await prisma.product.findFirstOrThrow({ where: { sku: "MAR-1" } })).id
    const mine = await request(app).post("/purchase-requests").set(employee.auth).send({ productId, quantity: 2 })
    const other = await request(app).post("/purchase-requests").set(admin.auth).send({ productId, quantity: 5 })
    await request(app).patch(`/purchase-requests/${other.body.id}/status`).set(admin.auth).send({ status: "APPROVED" })

    expect((await get("/purchase-requests")).body.total).toBe(2)
    expect((await get("/purchase-requests", employee)).body.total).toBe(1)
    expect((await get("/purchase-requests?status=PENDING")).body.items[0].id).toBe(mine.body.id)
    expect((await get("/purchase-requests?unlinked=1")).body.items.map((r: { id: string }) => r.id)).toEqual([other.body.id])
    expect((await get("/purchase-requests?q=martillo")).body.total).toBe(2)

    expect((await get(`/purchase-requests/${mine.body.id}`, employee)).status).toBe(200)
    expect((await get(`/purchase-requests/${other.body.id}`, employee)).status).toBe(404)
  })

  it("órdenes: filtro por estado y búsqueda por proveedor", async () => {
    const productId = (await prisma.product.findFirstOrThrow({ where: { sku: "MAR-1" } })).id
    const s = await prisma.supplier.create({ data: { companyId: admin.companyId, name: "Ferretera del Valle" } })
    const order = await request(app).post("/purchase-orders").set(admin.auth).send({ supplierId: s.id, items: [{ productId, quantity: 1, unitCost: 500 }] })
    expect((await get("/purchase-orders?status=PENDING")).body.total).toBe(1)
    expect((await get("/purchase-orders?status=RECEIVED")).body.total).toBe(0)
    expect((await get("/purchase-orders?q=valle")).body.items[0].id).toBe(order.body.id)
    expect((await get(`/purchase-orders?q=${order.body.id.slice(0, 8)}`)).body.total).toBe(1)
  })

  it("catálogos: sin page devuelven la lista completa (selectores); con page, paginan", async () => {
    await prisma.supplier.create({ data: { companyId: admin.companyId, name: "Abarrotera Sol", idType: "JURIDICA", idNumber: "3101123456" } })
    const all = (await get("/suppliers")).body
    expect(Array.isArray(all)).toBe(true)
    expect(all[0]).toMatchObject({ name: "Abarrotera Sol", _count: { products: 0 } })
    expect((await get("/suppliers?page=1&pageSize=1")).body).toMatchObject({ total: 2, pageCount: 2 })
    expect((await get("/suppliers?q=3101-123")).body.map((s: { name: string }) => s.name)).toEqual(["Abarrotera Sol"])

    await request(app).post("/customers").set(admin.auth).send({ name: "Cliente Uno", idType: "FISICA", idNumber: "112340567" })
    await request(app).post("/customers").set(admin.auth).send({ name: "Otro cliente" })
    expect((await get("/customers?page=1&pageSize=1")).body).toMatchObject({ total: 2, pageCount: 2 })
    expect((await get("/customers?q=1-1234")).body.map((c: { name: string }) => c.name)).toEqual(["Cliente Uno"])

    const users = (await get("/users?page=1&pageSize=1")).body
    expect(users).toMatchObject({ total: 2, pageCount: 2 })
    expect(users.items[0]).toHaveProperty("role")
    expect((await get(`/users?q=${encodeURIComponent(employee.user.email)}`)).body).toHaveLength(1)
  })

  it("auditoría paginada y filtrada", async () => {
    const res = (await get("/audit-logs?pageSize=1&entityType=PurchaseOrder")).body
    expect(res.total).toBeGreaterThanOrEqual(1)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].entityType).toBe("PurchaseOrder")
  })

  it("panel: totales calculados en el servidor; el empleado cuenta solo sus solicitudes", async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const d = (await get(`/reports/dashboard?since=${encodeURIComponent(since)}`)).body
    // 10 + 1 + 10 + 2,5 + 3 + 1 = 27,5 inicial; martillo +1 −1 +1 + orden pendiente (no suma)
    expect(d.units).toBe(28.5)
    expect(d.dispatchedSince).toBe(1)
    expect(d.stockByCategory[0]).toMatchObject({ name: "Herramientas" })
    expect(d.recentMovements).toHaveLength(3)
    expect(d.requests).toMatchObject({ PENDING: 1, APPROVED: 1 })
    expect((await get("/reports/dashboard", employee)).body.requests).toEqual({ PENDING: 1 })
  })
})

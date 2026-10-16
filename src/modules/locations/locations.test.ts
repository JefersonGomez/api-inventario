// Bloque 4A: sucursales y bodegas, stock por ubicación, personas por sucursal, límites del plan
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Sucursales, bodegas y stock por ubicación", () => {
  let admin: User, warehouseUser: User
  let main: string, bodega: string, categoryId: string
  const at = (u: User, locationId?: string) => ({ ...u.auth, ...(locationId && { "X-Location-Id": locationId }) })
  const stockAt = async (productId: string, locationId: string) =>
    Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId, locationId } } }))?.quantity ?? 0)
  const total = async (productId: string) => Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)
  const newProduct = async (sku: string, stock: number, extra: object = {}) =>
    (await request(app).post("/products").set(admin.auth).send({ sku, name: sku, price: 100, stock, minStock: 5, categoryId, ...extra })).body

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    warehouseUser = await createUser("EMPLOYE", admin.companyId)
    main = await mainLocationId(admin.companyId)
    categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "General" } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cada empresa nace con su sucursal principal (código 001)", async () => {
    const res = await request(app).get("/locations").set(admin.auth)
    expect(res.body).toEqual([expect.objectContaining({ id: main, name: "Sucursal principal", type: "BRANCH", code: "001" })])
  })

  it("el plan limita las sucursales; las bodegas no tienen límite ni código", async () => {
    const branch = await request(app).post("/locations").set(admin.auth).send({ name: "Sucursal Norte", type: "BRANCH" })
    expect(branch.status).toBe(400)
    expect(branch.body.error).toMatch(/1 sucursal/)

    const wh = await request(app).post("/locations").set(admin.auth).send({ name: "Bodega central", type: "WAREHOUSE" })
    expect(wh.status).toBe(201)
    expect(wh.body.code).toBeNull()
    bodega = wh.body.id

    await prisma.user.update({ where: { id: admin.user.id }, data: { plan: "PRO" } })
    const pro = await request(app).post("/locations").set(admin.auth).send({ name: "Sucursal Sur", type: "BRANCH" })
    expect(pro.body.code).toBe("002")
    expect((await request(app).post("/locations").set(warehouseUser.auth).send({ name: "X", type: "WAREHOUSE" })).status).toBe(403)
  })

  it("el stock se mueve por ubicación y el total del producto es la suma", async () => {
    const p = await newProduct("CLAVO", 10) // sin indicar: entra en la principal
    expect(await stockAt(p.id, main)).toBe(10)

    const move = (body: object) => request(app).post("/movements").set(admin.auth).send({ productId: p.id, ...body })
    expect((await move({ type: "IN", quantity: 30, locationId: bodega })).status).toBe(201)
    expect(await stockAt(p.id, bodega)).toBe(30)
    expect(await total(p.id)).toBe(40)

    // la salida se valida contra la ubicación, no contra el total
    const tooMuch = await move({ type: "OUT", quantity: 15, locationId: main })
    expect(tooMuch.status).toBe(400)
    expect(tooMuch.body.error).toMatch(/Stock insuficiente en Sucursal principal/)
    expect(await total(p.id)).toBe(40)

    // el ajuste es el conteo de ESA ubicación
    expect((await move({ type: "ADJUSTMENT", quantity: 25, locationId: bodega })).status).toBe(201)
    expect(await stockAt(p.id, bodega)).toBe(25)
    expect(await total(p.id)).toBe(35)

    // con la ubicación activa (selector), sin indicarla en el cuerpo
    await request(app).post("/movements").set(at(admin, bodega)).send({ productId: p.id, type: "OUT", quantity: 5 })
    expect(await stockAt(p.id, bodega)).toBe(20)
    const moves = (await request(app).get(`/movements?productId=${p.id}`).set(admin.auth)).body.items
    expect(moves[0]).toMatchObject({ type: "OUT", location: { id: bodega, name: "Bodega central" } })
  })

  it("con una ubicación elegida, productos y reportes muestran el stock de ahí", async () => {
    const p = await prisma.product.findFirstOrThrow({ where: { sku: "CLAVO" } }) // 10 en la principal, 20 en la bodega
    const stockIn = async (h: Record<string, string>) => (await request(app).get("/products?q=CLAVO").set(h)).body.items[0].stock
    expect(await stockIn(admin.auth)).toBe(30)
    expect(await stockIn(at(admin, main))).toBe(10)
    expect(await stockIn(at(admin, bodega))).toBe(20)

    const detail = (await request(app).get(`/products/${p.id}`).set(admin.auth)).body
    expect(detail.stocks).toHaveLength(2)

    // mínimo 5: bajo mínimo en la principal (sacando 6) pero no en la bodega ni en el total
    await request(app).post("/movements").set(admin.auth).send({ productId: p.id, type: "OUT", quantity: 6, locationId: main })
    const low = async (h: Record<string, string>) => (await request(app).get("/reports/low-stock").set(h)).body.map((x: { sku: string }) => x.sku)
    expect(await low(at(admin, main))).toContain("CLAVO")
    expect(await low(at(admin, bodega))).not.toContain("CLAVO")
    expect(await low(admin.auth)).not.toContain("CLAVO")
    const lowFilter = (await request(app).get("/products?lowStock=1").set(at(admin, main))).body.items.map((x: { sku: string }) => x.sku)
    expect(lowFilter).toContain("CLAVO")

    const value = (await request(app).get("/reports/inventory-value").set(at(admin, bodega))).body
    expect(value.retailValue).toBe(2000) // 20 × 100 en la bodega
  })

  it("quien trabaja en una sola ubicación solo ve y mueve lo de ahí", async () => {
    const p = await prisma.product.findFirstOrThrow({ where: { sku: "CLAVO" } })
    const res = await request(app).patch(`/users/${warehouseUser.user.id}/access`).set(admin.auth)
      .send({ role: "EMPLOYE", locationIds: [bodega] })
    expect(res.body.locationIds).toEqual([bodega])

    const me = (await request(app).get("/auth/me").set(warehouseUser.auth)).body.user
    expect(me).toMatchObject({ locationIds: [bodega], activeLocationId: bodega })
    expect((await request(app).get("/locations").set(warehouseUser.auth)).body.map((l: { id: string }) => l.id)).toEqual([bodega])

    // pedir otra ubicación en el encabezado no sirve: sigue viendo la suya
    const list = (await request(app).get("/products?q=CLAVO").set(at(warehouseUser, main))).body.items
    expect(list[0].stock).toBe(20)
    const moved = await request(app).post("/movements").set(warehouseUser.auth).send({ productId: p.id, type: "IN", quantity: 1, locationId: main })
    expect(moved.body.error).toMatch(/No trabajas en esa ubicación/)
    const theirs = (await request(app).get("/movements").set(warehouseUser.auth)).body.items
    expect(theirs.every((m: { location: { id: string } }) => m.location.id === bodega)).toBe(true)

    // ubicaciones de otra empresa: no se pueden asignar
    const other = await createUser("ADMIN")
    const foreign = await request(app).patch(`/users/${warehouseUser.user.id}/access`).set(admin.auth)
      .send({ role: "EMPLOYE", locationIds: [await mainLocationId(other.companyId)] })
    expect(foreign.status).toBe(400)
  })

  it("producto nuevo, importación y órdenes de compra entran en la ubicación indicada", async () => {
    const p = await newProduct("TORNILLO", 7, { locationId: bodega })
    expect(await stockAt(p.id, bodega)).toBe(7)
    expect(await stockAt(p.id, main)).toBe(0)

    const imp = await request(app).post("/products/import").set(admin.auth).send({
      rows: [{ rowNumber: 2, sku: "IMP-1", name: "Importado", category: "General", price: 10, stock: 4 }],
      dryRun: false,
      locationId: bodega,
    })
    expect(imp.body.created).toBe(1)
    const imported = await prisma.product.findFirstOrThrow({ where: { sku: "IMP-1" } })
    expect(await stockAt(imported.id, bodega)).toBe(4)

    const supplier = await prisma.supplier.create({ data: { companyId: admin.companyId, name: "Prov" } })
    const order = await request(app).post("/purchase-orders").set(admin.auth)
      .send({ supplierId: supplier.id, items: [{ productId: p.id, quantity: 3, unitCost: 50 }], locationId: bodega })
    expect(order.body.location).toMatchObject({ id: bodega })
    await request(app).patch(`/purchase-orders/${order.body.id}/receive`).set(admin.auth)
    expect(await stockAt(p.id, bodega)).toBe(10)
    expect(await total(p.id)).toBe(10)
  })

  it("una ubicación con stock no se desactiva; la empresa siempre conserva una activa", async () => {
    expect((await request(app).patch(`/locations/${bodega}`).set(admin.auth).send({ isActive: false })).body.error).toMatch(/stock/)
    const empty = await request(app).post("/locations").set(admin.auth).send({ name: "Bodega vacía", type: "WAREHOUSE" })
    expect((await request(app).patch(`/locations/${empty.body.id}`).set(admin.auth).send({ isActive: false })).body.isActive).toBe(false)
    // desactivada: ya no recibe movimientos
    const p = await prisma.product.findFirstOrThrow({ where: { sku: "CLAVO" } })
    const moved = await request(app).post("/movements").set(admin.auth).send({ productId: p.id, type: "IN", quantity: 1, locationId: empty.body.id })
    expect(moved.body.error).toMatch(/desactivada/)

    const solo = await createUser("ADMIN")
    const only = await mainLocationId(solo.companyId)
    expect((await request(app).patch(`/locations/${only}`).set(solo.auth).send({ isActive: false })).body.error).toMatch(/al menos una/)
  })
})

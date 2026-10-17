// Bloque 5B: conteo físico por ubicación
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Conteo físico", () => {
  let admin: User, clerk: User, accountant: User
  let main: string, bodega: string, toolsId: string, hammerId: string, nailsId: string, glueId: string
  const stockAt = async (productId: string, locationId = main) =>
    Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId, locationId } } }))?.quantity ?? 0)
  const save = (id: string, items: object[], u = clerk) => request(app).put(`/stock-counts/${id}/items`).set(u.auth).send({ items })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    main = await mainLocationId(c)
    bodega = (await request(app).post("/locations").set(admin.auth).send({ name: "Bodega", type: "WAREHOUSE" })).body.id
    clerk = await createUser("EMPLOYE", c)
    accountant = await createUser("ACCOUNTANT", c)
    await request(app).patch(`/users/${clerk.user.id}/access`).set(admin.auth).send({ role: "EMPLOYE", locationIds: [main] })
    toolsId = (await prisma.category.create({ data: { companyId: c, name: "Herramientas" } })).id
    const other = (await prisma.category.create({ data: { companyId: c, name: "Químicos" } })).id
    const create = async (sku: string, stock: number, categoryId: string) =>
      (await request(app).post("/products").set(admin.auth).send({ sku, name: sku, price: 100, stock, minStock: 0, categoryId })).body.id
    hammerId = await create("MARTILLO", 10, toolsId)
    nailsId = await create("CLAVOS", 50, toolsId)
    glueId = await create("PEGA", 7, other)
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  let countId: string

  it("abre un conteo de una categoría en una ubicación; uno abierto a la vez", async () => {
    const res = await request(app).post("/stock-counts").set(clerk.auth).send({ categoryId: toolsId })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: "OPEN", location: { id: main }, category: { id: toolsId } })
    expect(res.body.items.map((i: { productId: string }) => i.productId).sort()).toEqual([hammerId, nailsId].sort())
    expect(res.body.items.find((i: { productId: string }) => i.productId === hammerId)).toMatchObject({ countedQuantity: null, currentQuantity: 10 })
    countId = res.body.id

    expect((await request(app).post("/stock-counts").set(clerk.auth).send({})).body.error).toMatch(/Ya hay un conteo abierto/)
    // otra ubicación sí puede tener el suyo; pero solo quien trabaja ahí
    expect((await request(app).post("/stock-counts").set(clerk.auth).send({ locationId: bodega })).body.error).toMatch(/No trabajas/)
    expect((await request(app).post("/stock-counts").set(accountant.auth).send({})).status).toBe(403)
  })

  it("se cuenta de a poco; una venta a mitad del conteo no se descuenta dos veces", async () => {
    // martillo: el sistema dice 10, se cuentan 8 (faltan 2)
    let res = await save(countId, [{ productId: hammerId, countedQuantity: 8 }])
    expect(res.body.items.find((i: { productId: string }) => i.productId === hammerId)).toMatchObject({ countedQuantity: 8, systemQuantity: 10 })

    // después de contar el martillo se vende 1: el sistema queda en 9 y el estante en 7
    await request(app).post("/movements").set(admin.auth).send({ productId: hammerId, type: "OUT", quantity: 1, locationId: main })

    // clavos contados de más; la pega no estaba en la categoría pero apareció en el estante: se agrega
    res = await save(countId, [{ productId: nailsId, countedQuantity: 53 }, { productId: glueId, countedQuantity: 7 }])
    expect(res.body.items).toHaveLength(3)
    expect((await save(countId, [{ productId: hammerId, countedQuantity: 1.5 }])).status).toBe(400) // unidades enteras
  })

  it("al cerrar ajusta solo la diferencia, con movimientos de conteo", async () => {
    const res = await request(app).post(`/stock-counts/${countId}/close`).set(clerk.auth)
    expect(res.body.status).toBe("CLOSED")
    expect(await stockAt(hammerId)).toBe(7) // 9 − 2 de faltante (no 8: la venta ya se había descontado)
    expect(await stockAt(nailsId)).toBe(53)
    expect(await stockAt(glueId)).toBe(7) // sin diferencia, sin movimiento
    const moves = await prisma.stockMovement.findMany({ where: { source: "COUNT", sourceId: countId }, orderBy: { quantity: "asc" } })
    expect(moves.map((m) => [m.productId, m.type, Number(m.quantity)])).toEqual([
      [hammerId, "OUT", 2],
      [nailsId, "IN", 3],
    ])
    expect(await prisma.auditLog.findFirst({ where: { entityType: "StockCount", entityId: countId, action: "UPDATE" } })).toBeTruthy()
    expect((await save(countId, [{ productId: hammerId, countedQuantity: 1 }])).body.error).toMatch(/cerrado/)
  })

  it("no se cierra sin nada contado; se puede cancelar sin tocar el stock", async () => {
    const open = (await request(app).post("/stock-counts").set(admin.auth).send({ locationId: main })).body
    expect((await request(app).post(`/stock-counts/${open.id}/close`).set(admin.auth)).body.error).toMatch(/No hay nada contado/)
    await save(open.id, [{ productId: hammerId, countedQuantity: 0 }], admin)
    expect((await request(app).post(`/stock-counts/${open.id}/cancel`).set(admin.auth)).body.status).toBe("CANCELLED")
    expect(await stockAt(hammerId)).toBe(7)

    // cada uno ve los conteos de sus ubicaciones
    await request(app).post("/stock-counts").set(admin.auth).send({ locationId: bodega })
    const mine = (await request(app).get("/stock-counts").set(clerk.auth)).body.items
    expect(mine.every((c: { location: { id: string } }) => c.location.id === main)).toBe(true)
    expect((await request(app).get("/stock-counts").set(admin.auth)).body.total).toBe(3)
  })
})

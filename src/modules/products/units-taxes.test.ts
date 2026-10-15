// Bloque 1A: unidades con decimales, IVA/CABYS, origen de los movimientos y búsqueda por código
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { parseTaxRate, parseUnit } from "../../shared/units.ts"

type Admin = Awaited<ReturnType<typeof createUser>>

describe("Unidades, impuestos y origen de movimientos", () => {
  let admin: Admin
  let categoryId: string

  const newProduct = (body: Record<string, unknown>) =>
    request(app).post("/products").set(admin.auth).send({ price: 1000, stock: 0, minStock: 0, categoryId, ...body })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    categoryId = (await prisma.category.create({ data: { name: "Granel", companyId: admin.companyId } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("un producto por kg acepta decimales, devuelve números y su stock inicial queda como movimiento INITIAL", async () => {
    const res = await newProduct({ sku: "KG-1", name: "Queso", unit: "KG", stock: 2.5, minStock: 0.75, taxRate: "RATE_1", cabys: "2391000000000" })
    expect(res.status).toBe(201)
    // los Decimal salen como número en el JSON (no "2.500")
    expect(res.body).toMatchObject({ unit: "KG", stock: 2.5, minStock: 0.75, taxRate: "RATE_1", cabys: "2391000000000", price: 1000 })

    const moves = await prisma.stockMovement.findMany({ where: { productId: res.body.id } })
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ type: "IN", source: "INITIAL", sourceId: null })
    expect(Number(moves[0]!.quantity)).toBe(2.5)
  })

  it("por defecto es por unidad, IVA 13 % y sin CABYS; sin stock no crea movimiento", async () => {
    const res = await newProduct({ sku: "U-0", name: "Martillo" })
    expect(res.body).toMatchObject({ unit: "UNIT", taxRate: "RATE_13", cabys: null, stock: 0 })
    expect(await prisma.stockMovement.count({ where: { productId: res.body.id } })).toBe(0)
  })

  it("por unidad rechaza decimales; CABYS debe tener 13 dígitos; máximo 3 decimales", async () => {
    expect((await newProduct({ sku: "U-1", name: "Tornillo", stock: 2.5 })).status).toBe(400)
    expect((await newProduct({ sku: "U-2", name: "Tornillo", cabys: "123" })).status).toBe(400)
    expect((await newProduct({ sku: "KG-2", name: "Arroz", unit: "KG", stock: 1.2345 })).status).toBe(400)
  })

  it("movimientos con decimales según la unidad (sin errores de punto flotante)", async () => {
    const kg = await newProduct({ sku: "KG-3", name: "Clavos", unit: "KG", stock: 0.3 })
    const out = await request(app).post("/movements").set(admin.auth).send({ productId: kg.body.id, type: "IN", quantity: 0.1 })
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ source: "MANUAL", quantity: 0.1 })
    // 0.3 + 0.1 en number da 0.40000000000000002: con Decimal queda exacto
    const after = await prisma.product.findUniqueOrThrow({ where: { id: kg.body.id } })
    expect(after.stock.toString()).toBe("0.4")

    const unit = await newProduct({ sku: "U-3", name: "Llave", stock: 5 })
    const bad = await request(app).post("/movements").set(admin.auth).send({ productId: unit.body.id, type: "OUT", quantity: 1.5 })
    expect(bad.status).toBe(400)
  })

  it("no deja pasar a 'unidad' un producto con stock fraccionado", async () => {
    const kg = await newProduct({ sku: "KG-4", name: "Cable", unit: "M", stock: 3.5 })
    const res = await request(app).put(`/products/${kg.body.id}`).set(admin.auth)
      .send({ name: "Cable", price: 1000, minStock: 0, categoryId, unit: "UNIT" })
    expect(res.status).toBe(400)
    const ok = await request(app).put(`/products/${kg.body.id}`).set(admin.auth)
      .send({ name: "Cable", price: 1000, minStock: 1.5, categoryId, taxRate: "EXEMPT" })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ unit: "M", taxRate: "EXEMPT", minStock: 1.5 })
  })

  it("stock bajo compara números, no texto ('10.500' <= '9.000' sería verdadero)", async () => {
    const low = await newProduct({ sku: "LOW-1", name: "Bajo", unit: "KG", stock: 9.5, minStock: 10 })
    const fine = await newProduct({ sku: "LOW-2", name: "Bien", unit: "KG", stock: 10.5, minStock: 9 })
    const res = await request(app).get("/reports/low-stock").set(admin.auth)
    const ids = (res.body as { id: string }[]).map((p) => p.id)
    expect(ids).toContain(low.body.id)
    expect(ids).not.toContain(fine.body.id)
  })

  it("la recepción de una orden deja movimientos PURCHASE_RECEIPT con el id de la orden", async () => {
    const product = await newProduct({ sku: "KG-5", name: "Harina", unit: "KG", stock: 1 })
    const supplier = await prisma.supplier.create({ data: { name: "Molino", companyId: admin.companyId } })
    const order = await request(app).post("/purchase-orders").set(admin.auth)
      .send({ supplierId: supplier.id, items: [{ productId: product.body.id, quantity: 12.5, unitCost: 400 }] })
    expect(order.status).toBe(201)
    expect(order.body.items[0].quantity).toBe(12.5)
    expect((await request(app).patch(`/purchase-orders/${order.body.id}/receive`).set(admin.auth)).status).toBe(200)

    const receipt = await prisma.stockMovement.findFirstOrThrow({ where: { productId: product.body.id, source: "PURCHASE_RECEIPT" } })
    expect(receipt.sourceId).toBe(order.body.id)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.body.id } })).stock)).toBe(13.5)

    // por unidad, la orden no acepta cantidades fraccionadas
    const unit = await newProduct({ sku: "U-5", name: "Saco" })
    const bad = await request(app).post("/purchase-orders").set(admin.auth)
      .send({ supplierId: supplier.id, items: [{ productId: unit.body.id, quantity: 2.5, unitCost: 400 }] })
    expect(bad.status).toBe(400)
  })

  it("búsqueda exacta por código de barras, limitada a la empresa", async () => {
    await newProduct({ sku: "BC-1", name: "Con código", barcode: "7441000000017" })
    const other = await createUser("ADMIN")
    const otherCat = await prisma.category.create({ data: { name: "X", companyId: other.companyId } })
    await prisma.product.create({ data: { companyId: other.companyId, sku: "BC-9", name: "Ajeno", price: 1, categoryId: otherCat.id, barcode: "7441000000024" } })

    const found = await request(app).get("/products/barcode/7441000000017").set(admin.auth)
    expect(found.body).toMatchObject({ sku: "BC-1" })
    const foreign = await request(app).get("/products/barcode/7441000000024").set(admin.auth)
    expect(foreign.body?.sku).not.toBe("BC-9")
  })

  it("importación: unidad/IVA/CABYS desde texto libre, decimales según la unidad y stock inicial como movimiento", async () => {
    const send = (rows: unknown[], options?: Record<string, unknown>) =>
      request(app).post("/products/import").set(admin.auth).send({ rows, dryRun: false, ...(options && { options }) })
    const base = { category: "Granel", price: 500 }

    const strict = await send([
      { rowNumber: 2, sku: "IM-1", name: "Azúcar", unit: "Kilos", taxRate: "1 %", cabys: "2351000000000", stock: 7.25, ...base },
      { rowNumber: 3, sku: "IM-2", name: "Caja", unit: "caja", ...base },
      { rowNumber: 4, sku: "IM-3", name: "Lápiz", stock: 1.5, ...base },
    ])
    expect(strict.body.created).toBe(1)
    expect(strict.body.summary.groups).toMatchObject({ badFiscal: 1, badNumbers: 1 })
    const sugar = await prisma.product.findFirstOrThrow({ where: { sku: "IM-1", companyId: admin.companyId } })
    expect(sugar).toMatchObject({ unit: "KG", taxRate: "RATE_1", cabys: "2351000000000" })
    expect(Number(sugar.stock)).toBe(7.25)
    expect(await prisma.stockMovement.findFirst({ where: { productId: sugar.id, source: "INITIAL" } })).toBeTruthy()

    const fixed = await send([{ rowNumber: 2, sku: "IM-2", name: "Caja", unit: "caja", taxRate: "8", cabys: "12", ...base }], { ignoreBadFiscal: true })
    expect(fixed.body.created).toBe(1)
    expect(await prisma.product.findFirstOrThrow({ where: { sku: "IM-2", companyId: admin.companyId } }))
      .toMatchObject({ unit: "UNIT", taxRate: "RATE_13", cabys: null })
  })

  it("los textos de unidad e IVA se reconocen sin importar tildes, mayúsculas o formato", () => {
    for (const [raw, want] of [["Kg", "KG"], ["kilogramos", "KG"], ["unid.", "UNIT"], ["Litros", "L"], ["m²", "M2"], ["mL", "ML"], ["caja", null]] as const) {
      expect(parseUnit(raw)).toBe(want)
    }
    for (const [raw, want] of [["13", "RATE_13"], ["13 %", "RATE_13"], ["0.13", "RATE_13"], ["0,04", "RATE_4"], ["Exento", "EXEMPT"], ["1%", "RATE_1"], ["8", null]] as const) {
      expect(parseTaxRate(raw)).toBe(want)
    }
  })
})

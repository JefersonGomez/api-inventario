// Importación de productos desde Excel: vista previa, reglas por fila, arreglos en bloque,
// actualización de existentes, límite del plan y aislamiento entre empresas
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

type Row = Record<string, unknown>
const row = (n: number, extra: Row = {}): Row => ({ rowNumber: n, sku: `SKU-${n}`, name: `Producto ${n}`, category: "Ferretería", price: 1000, ...extra })
const RECOMMENDED = {
  defaultCategory: "General", generateSku: true, pendingPrice: true, fixNumbers: true,
  ignoreInvalidDate: true, dropConflictingBarcode: true, skipRepeated: true, updateExisting: false,
}
const find = (body: { rows: Row[] }, n: number) => body.rows.find((r) => r.rowNumber === n) as Row & { errors: string[]; fixes: string[] }

describe("Importar productos", () => {
  let admin: Awaited<ReturnType<typeof createUser>>

  beforeEach(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  const send = (rows: Row[], dryRun: boolean, options?: object, auth = admin.auth) =>
    request(app).post("/products/import").set(auth).send({ rows, dryRun, ...(options && { options }) })

  describe("modo estricto (sin arreglos)", () => {
    it("la vista previa no escribe nada y explica cada fila", async () => {
      const res = await send([row(2), row(3, { price: 0 }), row(4, { sku: "" }), row(5, { stock: 1.5 })], true)
      expect(res.status).toBe(200)
      expect(res.body.summary).toMatchObject({ total: 4, toCreate: 1, errors: 3, skipped: 0, newCategories: ["Ferretería"] })
      expect(find(res.body, 3).errors[0]).toContain("mayor que 0")
      expect(find(res.body, 4).errors).toContain("Falta el SKU")
      expect(find(res.body, 5).errors[0]).toContain("entero")
      expect(await prisma.product.count()).toBe(0)
    })

    it("importa solo las válidas, crea categorías y proveedores, y queda en auditoría", async () => {
      const res = await send([
        row(2, { cost: 600, stock: 10, minStock: 2, barcode: "7441", supplier: "Distribuidora Sol", expirationDate: "2027-01-31" }),
        row(3, { category: "ferretería" }),
        row(4, { name: "" }),
      ], false)
      expect(res.status).toBe(201)
      expect(res.body.created).toBe(2)
      const products = await prisma.product.findMany({ where: { companyId: admin.companyId }, orderBy: { sku: "asc" } })
      expect(products.map((p) => p.sku)).toEqual(["SKU-2", "SKU-3"])
      expect(products[0]).toMatchObject({ barcode: "7441", pendingReview: false })
      expect([Number(products[0]!.stock), Number(products[0]!.minStock)]).toEqual([10, 2])
      expect(Number(products[0]!.cost)).toBe(600)
      expect(await prisma.category.count({ where: { companyId: admin.companyId } })).toBe(1)
      expect((await prisma.supplier.findFirstOrThrow({ where: { companyId: admin.companyId } })).name).toBe("Distribuidora Sol")
      const audit = await prisma.auditLog.findFirst({ where: { companyId: admin.companyId, entityType: "ProductImport" } })
      expect(audit?.changes).toMatchObject({ created: 2, errors: 1 })
    })

    it("un SKU existente se salta sin tocar el producto; repetidos en el archivo dan error", async () => {
      const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "Ferretería" } })
      await prisma.product.create({ data: { companyId: admin.companyId, sku: "SKU-2", name: "Original", price: 5, categoryId: category.id } })
      const res = await send([row(2, { name: "Nombre nuevo", price: undefined }), row(3), row(4, { sku: "sku-3" })], false)
      expect(res.body.summary).toMatchObject({ toCreate: 1, skipped: 1, errors: 1 })
      expect(find(res.body, 2).status).toBe("skip")
      expect((await prisma.product.findFirstOrThrow({ where: { sku: "SKU-2" } })).name).toBe("Original")
      expect(find(res.body, 4).errors).toContain("SKU repetido en el archivo")
    })
  })

  describe("arreglos en bloque", () => {
    it("cuenta cada tipo de problema y con los arreglos recomendados casi todo entra", async () => {
      const rows = [
        row(2, { category: "" }),
        row(3, { sku: "" }),
        row(4, { price: undefined }),
        row(5, { price: -1 }), // precio que no era número
        row(6, { stock: 2.6, minStock: -3, cost: -5 }),
        row(7, { expirationDate: "31/02/2027x" }),
        row(10),
        row(8, { sku: "SKU-10" }), // repetido de una fila válida
        row(9, { name: "" }), // sin arreglo posible
      ]
      const strict = await send(rows, true)
      expect(strict.body.summary.groups).toMatchObject({
        missingCategory: 1, missingSku: 1, missingPrice: 2, badNumbers: 1, invalidDate: 1, repeatedSku: 1,
      })
      expect(strict.body.summary.errors).toBe(8)

      const fixed = await send(rows, false, RECOMMENDED)
      expect(fixed.body.summary).toMatchObject({ toCreate: 7, skipped: 1, errors: 1, pending: 2 })
      expect(find(fixed.body, 9).errors[0]).toContain("Falta el nombre")
      expect(find(fixed.body, 3).sku).toBe("IMP-0001")

      const bySku = Object.fromEntries((await prisma.product.findMany({ include: { category: true } })).map((p) => [p.sku, p]))
      expect(bySku["SKU-2"]!.category.name).toBe("General")
      expect(bySku["IMP-0001"]).toBeTruthy()
      expect(bySku["SKU-4"]).toMatchObject({ pendingReview: true })
      expect(Number(bySku["SKU-4"]!.price)).toBe(0)
      expect(bySku["SKU-5"]!.pendingReview).toBe(true)
      expect(bySku["SKU-6"]).toMatchObject({ cost: null })
      expect([Number(bySku["SKU-6"]!.stock), Number(bySku["SKU-6"]!.minStock)]).toEqual([3, 0])
      expect(bySku["SKU-7"]).toMatchObject({ expirationDate: null })
      expect(bySku["SKU-10"]!.name).toBe("Producto 10") // la primera fila gana
    })

    it("los SKU generados no chocan con los que ya existen", async () => {
      const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "C" } })
      await prisma.product.create({ data: { companyId: admin.companyId, sku: "IMP-0001", name: "Previo", price: 1, categoryId: category.id } })
      const res = await send([row(2, { sku: "" }), row(3, { sku: "" })], false, RECOMMENDED)
      expect(res.body.rows.map((r: Row) => r.sku)).toEqual(["IMP-0002", "IMP-0003"])
    })

    it("un código de barras en conflicto se descarta en vez de frenar la fila", async () => {
      const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "C" } })
      await prisma.product.create({ data: { companyId: admin.companyId, sku: "X", name: "X", price: 1, barcode: "777", categoryId: category.id } })
      const res = await send([row(2, { barcode: "777" })], false, RECOMMENDED)
      expect(res.body.created).toBe(1)
      expect((await prisma.product.findFirstOrThrow({ where: { sku: "SKU-2" } })).barcode).toBeNull()
    })

    it("editar un producto 'Por completar' con su precio le quita la marca", async () => {
      await send([row(2, { price: undefined })], false, RECOMMENDED)
      const p = await prisma.product.findFirstOrThrow({ where: { sku: "SKU-2" } })
      expect(p.pendingReview).toBe(true)
      const res = await request(app).put(`/products/${p.id}`).set(admin.auth)
        .send({ name: p.name, price: 2500, minStock: 0, categoryId: p.categoryId })
      expect(res.status).toBe(200)
      expect(res.body.pendingReview).toBe(false)
    })
  })

  describe("actualizar existentes", () => {
    it("actualiza solo lo que trae el archivo, nunca el stock, y deja historial de precio", async () => {
      const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "Ferretería" } })
      const original = await prisma.product.create({
        data: { companyId: admin.companyId, sku: "SKU-2", name: "Original", price: 500, stock: 40, minStock: 5, description: "se queda", categoryId: category.id },
      })
      const res = await send([row(2, { name: "Renombrado", price: 750, stock: 999, description: undefined })], false, { ...RECOMMENDED, updateExisting: true })
      expect(res.body.summary).toMatchObject({ toUpdate: 1, toCreate: 0 })
      const after = await prisma.product.findUniqueOrThrow({ where: { id: original.id } })
      expect(after).toMatchObject({ name: "Renombrado", description: "se queda" })
      expect([Number(after.stock), Number(after.minStock)]).toEqual([40, 5])
      expect(Number(after.price)).toBe(750)

      const history = await request(app).get(`/products/${original.id}/price-history`).set(admin.auth)
      expect(history.body.history.map((h: { price: number }) => h.price)).toContain(750)
    })

    it("sin precio en el archivo, un existente conserva el suyo", async () => {
      const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "Ferretería" } })
      await prisma.product.create({ data: { companyId: admin.companyId, sku: "SKU-2", name: "Original", price: 500, categoryId: category.id } })
      await send([row(2, { price: undefined, category: undefined, name: "Nuevo nombre" })], false, { ...RECOMMENDED, updateExisting: true })
      const p = await prisma.product.findFirstOrThrow({ where: { sku: "SKU-2" } })
      expect(Number(p.price)).toBe(500)
      expect(p.pendingReview).toBe(false)
      expect(p.categoryId).toBe(category.id)
    })
  })

  it("respeta el límite de productos del plan (las actualizaciones no cuentan)", async () => {
    const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "C" } })
    await prisma.product.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({ companyId: admin.companyId, sku: `E-${i}`, name: `E${i}`, price: 1, categoryId: category.id })),
    })
    const res = await send([row(2), row(3), row(4)], false)
    expect(res.body.created).toBe(2)
    expect(find(res.body, 4).errors[0]).toContain("500")
  })

  it("cada empresa importa en la suya", async () => {
    const other = await createUser("ADMIN")
    await send([row(2)], false, undefined, other.auth)
    expect((await send([row(2)], false)).body.created).toBe(1)
  })

  it("solo el administrador importa, y el cuerpo se valida", async () => {
    const emp = await createUser("EMPLOYE", admin.companyId)
    expect((await send([row(2)], true, undefined, emp.auth)).status).toBe(403)
    expect((await send([], true)).status).toBe(400)
    expect((await send([row(2)], true, { generateSku: "si" })).status).toBe(400)
  })

  it("acepta archivos grandes (2000 filas) aunque el límite general sea de 100 KB", async () => {
    await prisma.user.update({ where: { id: admin.user.id }, data: { plan: "PRO" } })
    const rows = Array.from({ length: 2000 }, (_, i) => row(i + 2, { description: "x".repeat(60) }))
    const res = await send(rows, true)
    expect(res.status).toBe(200)
    expect(res.body.summary.toCreate).toBe(2000)
    expect((await send([...rows, row(3000)], true)).status).toBe(400)
  })
})

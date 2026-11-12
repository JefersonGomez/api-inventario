// La mercadería de la factura del proveedor entra al inventario (Bloque 9, punto 48 — parte 3)
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"
import { COMPANY_ID, makeP12, SUPPLIER_ID, supplierInvoice } from "../../test/einvoice-fixtures.ts"
import { loadSigningKey, signXml } from "../einvoice/signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "../einvoice/xml.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Factura del proveedor → inventario", () => {
  let admin: User, accountant: User
  let key: Awaited<ReturnType<typeof loadSigningKey>>
  let categoryId: string, hammerId: string, main: string
  const signed = async (d: EInvoiceData) => signXml(buildEInvoiceXml(d), key)
  const importInvoice = async (xml: string) =>
    (await request(app).post("/payables/invoices/xml").set(admin.auth).attach("files", Buffer.from(xml, "utf8"), "f.xml")).body.id as string
  const plan = (id: string, who: User = admin) => request(app).get(`/payables/invoices/${id}/stock`).set(who.auth)
  const receive = (id: string, body: object) => request(app).post(`/payables/invoices/${id}/stock`).set(admin.auth).send(body)
  const product = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    accountant = await createUser("ACCOUNTANT", admin.companyId)
    await prisma.company.update({ where: { id: admin.companyId }, data: { idType: "JURIDICA", idNumber: COMPANY_ID } })
    key = await loadSigningKey(makeP12("1234", `CPJ-${SUPPLIER_ID}`), "1234")
    main = await mainLocationId(admin.companyId)
    categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Herramientas" } })).id
    hammerId = (await request(app).post("/products").set(admin.auth).send({
      sku: "MRT-16", name: "Martillo de uña", price: 6500, cost: 2500, stock: 10, minStock: 0, categoryId, cabys: "4292199990200", locationId: main,
    })).body.id
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("sugiere el producto, entra con su costo promedio, crea el que falta y recuerda el emparejamiento", async () => {
    const id = await importInvoice(await signed(supplierInvoice()))
    const p = await plan(id)
    expect(p.status).toBe(200)
    expect(p.body.invoice).toMatchObject({ id, supplier: "Distribuidora de Prueba S.A.", receivedAt: null })
    expect(p.body.lines).toEqual([
      expect.objectContaining({ line: 1, description: "Martillo de uña 16 oz", quantity: 2, unit: "Unid", unitCost: 2900, suggestedUnit: "UNIT", suggestion: expect.objectContaining({ reason: "cabys", factor: 1, product: expect.objectContaining({ id: hammerId }) }) }),
      expect.objectContaining({ line: 2, description: "Arroz precocido", quantity: 1, unit: "Kg", unitCost: 1000, suggestedUnit: "KG", rate: "RATE_1", suggestion: null }),
    ])

    const res = await receive(id, {
      locationId: main,
      lines: [{ line: 1, productId: hammerId }, { line: 2, newProduct: { name: "Arroz precocido (kg)", price: 1500, categoryId } }],
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ created: 1, entered: [expect.objectContaining({ line: 1, quantity: 2, unitCost: 2900 }), expect.objectContaining({ line: 2, quantity: 1 })] })
    // martillo: 10 a 2500 + 2 a 2900 → 12 a 2566.67
    const hammer = await product(hammerId)
    expect(Number(hammer.stock)).toBe(12)
    expect(Number(hammer.cost)).toBeCloseTo(2566.6667, 3)
    // arroz: producto nuevo con lo que dice la factura
    const rice = await prisma.product.findFirstOrThrow({ where: { name: "Arroz precocido (kg)" } })
    expect(rice).toMatchObject({ unit: "KG", taxRate: "RATE_1", cabys: "2314000991000" })
    expect(Number(rice.stock)).toBe(1)
    expect(Number(rice.cost)).toBe(1000)
    // movimientos con su origen y la factura marcada
    const moves = await prisma.stockMovement.findMany({ where: { source: "SUPPLIER_INVOICE", sourceId: id } })
    expect(moves).toHaveLength(2)
    expect((await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } })).stockReceivedAt).not.toBeNull()
    expect((await receive(id, { lines: [{ line: 1, productId: hammerId }] })).body.error).toMatch(/ya entró/)

    // la siguiente factura del mismo proveedor ya sabe a qué producto va cada línea
    const next = await importInvoice(await signed(supplierInvoice()))
    const suggested = (await plan(next)).body.lines.map((l: { suggestion: { reason: string; product: { id: string } } }) => [l.suggestion.reason, l.suggestion.product.id])
    expect(suggested).toEqual([["remembered", hammerId], ["remembered", rice.id]])
    // cada "unidad" del proveedor trae 2 nuestras: entran 4 al costo de 1450 c/u; la línea del arroz no entra
    const withFactor = await receive(next, { lines: [{ line: 1, productId: hammerId, factor: 2 }, { line: 2, skip: true }] })
    expect(withFactor.body.entered).toEqual([expect.objectContaining({ quantity: 4, unitCost: 1450 })])
    expect(Number((await product(hammerId)).stock)).toBe(16)
    expect(Number((await product(rice.id)).stock)).toBe(1)
    const third = await importInvoice(await signed(supplierInvoice()))
    expect((await plan(third)).body.lines[0].suggestion).toMatchObject({ reason: "remembered", factor: 2 })
  })

  it("por el código del proveedor; si no da crédito fiscal el IVA es parte del costo", async () => {
    await prisma.product.update({ where: { id: hammerId }, data: { barcode: "7441234567890" } })
    // la línea trae el código comercial del proveedor (= nuestro código de barras); a nombre de otra persona
    const xml = buildEInvoiceXml(supplierInvoice({ receiver: { name: "Juan Pérez", idType: "FISICA", idNumber: "112345678" }, emitter: { ...supplierInvoice().emitter, idNumber: "3101777666", name: "Otro Proveedor S.A." } }))
      .replace("<CodigoCABYS>4292199990200</CodigoCABYS>", "<CodigoCABYS>4292199990200</CodigoCABYS><CodigoComercial><Tipo>01</Tipo><Codigo>7441234567890</Codigo></CodigoComercial>")
    const id = await importInvoice(await signXml(xml, key))
    const line = (await plan(id)).body.lines[0]
    expect(line).toMatchObject({ code: "7441234567890", unitCost: 3277, suggestion: { reason: "code", product: { id: hammerId } } }) // (5800 + 754) / 2
  })

  it("valida lo que llega y quién puede hacerlo", async () => {
    const id = await importInvoice(await signed(supplierInvoice()))
    expect((await receive(id, { lines: [{ line: 1, skip: true }, { line: 2, skip: true }] })).body.error).toMatch(/al menos un producto/)
    expect((await receive(id, { lines: [{ line: 1 }] })).body.error).toMatch(/elige el producto/)
    expect((await receive(id, { lines: [{ line: 9, productId: hammerId }] })).body.error).toMatch(/no es de esta factura/)
    // media unidad de un producto que se vende por unidad: no
    expect((await receive(id, { lines: [{ line: 2, productId: hammerId, factor: 0.5 }] })).body.error).toMatch(/Línea 2/)
    expect((await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } })).stockReceivedAt).toBeNull() // nada a medias
    expect((await plan(id, accountant)).status).toBe(403) // sin stock.move
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { idNumber: SUPPLIER_ID } })
    const manual = await request(app).post("/payables/invoices").set(admin.auth)
      .send({ supplierId: supplier.id, number: "B-1", issueDate: "2026-11-10", lines: [{ rate: "RATE_13", base: 1000 }] })
    expect((await plan(manual.body.id)).body.error).toMatch(/registró a mano/)
  })
})

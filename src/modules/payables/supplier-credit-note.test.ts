// Notas de crédito de proveedores desde su XML: rebajan lo que se debe, el crédito fiscal y (opcional) el inventario
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"
import { COMPANY_ID, makeP12, SUPPLIER_ID, supplierInvoice } from "../../test/einvoice-fixtures.ts"
import { loadSigningKey, signXml } from "../einvoice/signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "../einvoice/xml.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Notas de crédito de proveedores", () => {
  let admin: User
  let key: Awaited<ReturnType<typeof loadSigningKey>>
  let main: string, hammerId: string
  const signed = async (d: EInvoiceData) => signXml(buildEInvoiceXml(d), key)
  const preview = (xml: string) => request(app).post("/payables/invoices/xml/preview").set(admin.auth).attach("files", Buffer.from(xml, "utf8"), "n.xml")
  const register = (xml: string) => request(app).post("/payables/invoices/xml").set(admin.auth).attach("files", Buffer.from(xml, "utf8"), "n.xml")
  let noteSeq = 0
  // nota de crédito: devuelve 1 de los 2 martillos de la factura (base 2900 + IVA 377)
  const creditNote = (original: EInvoiceData, over: Partial<EInvoiceData> = {}) =>
    supplierInvoice({
      type: "CREDIT_NOTE", consecutive: `0010000103${String(++noteSeq).padStart(10, "0")}`,
      reference: { type: "INVOICE", clave: original.clave, issuedAt: original.issuedAt, code: "06", reason: "Devolución de 1 martillo" },
      lines: [{ cabys: "4292199990200", quantity: 1, unit: "UNIT", description: "Martillo de uña 16 oz", unitPrice: "3000", discount: "100", taxRate: "RATE_13", subtotal: "2900", taxAmount: "377" }],
      ...over,
    })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    await prisma.company.update({ where: { id: admin.companyId }, data: { idType: "JURIDICA", idNumber: COMPANY_ID } })
    key = await loadSigningKey(makeP12("1234", `CPJ-${SUPPLIER_ID}`), "1234")
    main = await mainLocationId(admin.companyId)
    const categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Herramientas" } })).id
    hammerId = (await request(app).post("/products").set(admin.auth).send({
      sku: "MRT", name: "Martillo", price: 6500, cost: 2500, stock: 10, minStock: 0, categoryId, cabys: "4292199990200", locationId: main,
    })).body.id
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("rebaja la factura que corrige, el saldo con el proveedor y el IVA acreditable del mes", async () => {
    const invoiceData = supplierInvoice() // 7564 a 30 días
    const invoice = (await register(await signed(invoiceData))).body
    const noteXml = await signed(creditNote(invoiceData))

    const p = await preview(noteXml)
    expect(p.body).toMatchObject({
      kind: "CREDIT_NOTE", total: 3277, dueDate: p.body.issueDate, creditable: true, canImport: true,
      credit: { original: { id: invoice.id }, applied: [{ id: invoice.id, amount: 3277 }], unapplied: 0 },
    })

    const res = await register(noteXml)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ type: "CREDIT_NOTE", total: 3277 })
    const note = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: res.body.id } })
    expect(note).toMatchObject({ type: "CREDIT_NOTE", referenceInvoiceId: invoice.id })
    expect(Number(note.paid)).toBe(3277) // la nota no queda como deuda
    // el abono de la nota: no es plata del banco, rebaja la factura original
    const payment = await prisma.supplierPayment.findUniqueOrThrow({ where: { creditNoteId: note.id }, include: { allocations: true } })
    expect(payment).toMatchObject({ method: "OTHER", reference: `NC ${note.number.slice(-10)}` })
    expect(payment.allocations.map((a) => [a.invoiceId, Number(a.amount)])).toEqual([[invoice.id, 3277]])
    expect(Number((await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).paid)).toBe(3277)
    const account = (await request(app).get(`/payables/${invoice.supplierId}`).set(admin.auth)).body
    expect(account.balance).toBe(4287) // 7564 − 3277

    // IVA del mes: compras 5800 + 1000 menos la nota 2900; IVA 754 + 10 − 377
    const vat = (await request(app).get("/reports/vat?month=2026-11").set(admin.auth)).body
    const r13 = vat.purchases.creditable.rows.find((r: { rate: string }) => r.rate === "RATE_13")
    expect(r13).toMatchObject({ base: 2900, tax: 377 })
    expect(vat.purchases.invoices.find((i: { id: string }) => i.id === note.id)).toMatchObject({ type: "CREDIT_NOTE", total: -3277, tax: -377 })

    // no se anula ni se importa dos veces
    expect((await request(app).post(`/payables/invoices/${note.id}/void`).set(admin.auth).send({ reason: "x" })).body.error).toMatch(/no se anula/)
    expect((await preview(noteXml)).body.canImport).toBe(false)
  })

  it("la devolución al proveedor sale del inventario sin cambiar el costo", async () => {
    const note = await prisma.supplierInvoice.findFirstOrThrow({ where: { type: "CREDIT_NOTE" } })
    const plan = (await request(app).get(`/payables/invoices/${note.id}/stock`).set(admin.auth)).body
    expect(plan.invoice).toMatchObject({ type: "CREDIT_NOTE", direction: "OUT" })
    expect(plan.lines[0].suggestion.product.id).toBe(hammerId) // por su CABYS
    const before = await prisma.product.findUniqueOrThrow({ where: { id: hammerId } })
    expect((await request(app).post(`/payables/invoices/${note.id}/stock`).set(admin.auth)
      .send({ lines: [{ line: 1, newProduct: { name: "x", price: 1, categoryId: before.categoryId } }] })).body.error).toMatch(/solo salen productos/)
    const res = await request(app).post(`/payables/invoices/${note.id}/stock`).set(admin.auth).send({ locationId: main, lines: [{ line: 1, productId: hammerId }] })
    expect(res.status).toBe(200)
    const after = await prisma.product.findUniqueOrThrow({ where: { id: hammerId } })
    expect(Number(after.stock)).toBe(Number(before.stock) - 1)
    expect(Number(after.cost)).toBe(Number(before.cost))
    const move = await prisma.stockMovement.findFirstOrThrow({ where: { sourceId: note.id } })
    expect(move).toMatchObject({ type: "OUT", source: "SUPPLIER_INVOICE" })
  })

  it("sin la factura original registrada rebaja las facturas abiertas del proveedor; lo que sobra queda a favor", async () => {
    const other = supplierInvoice() // factura que nunca se importó
    const big = creditNote(other, {
      lines: [{ cabys: "4292199990200", quantity: 10, unit: "UNIT", description: "Martillo", unitPrice: "1000", discount: 0, taxRate: "RATE_13", subtotal: "10000", taxAmount: "1300" }],
    })
    const p = await preview(await signed(big))
    expect(p.body.notices.map((n: { code: string }) => n.code)).toEqual(expect.arrayContaining(["NO_ORIGINAL", "UNAPPLIED"]))
    // lo único abierto del proveedor es lo que quedó de la primera factura (4287)
    expect(p.body.credit).toMatchObject({ original: null, applied: [{ amount: 4287 }], unapplied: 7013 })
    const res = await register(await signed(big))
    expect(res.status).toBe(201)
    const account = (await request(app).get(`/payables/${res.body.supplierId}`).set(admin.auth)).body
    expect(account.balance).toBe(0)
  })
})

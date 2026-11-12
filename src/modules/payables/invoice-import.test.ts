// Importar la factura electrónica de un proveedor desde su XML (Bloque 9, punto 48 — parte 1)
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { answerXml, COMPANY_ID, makeP12, SUPPLIER_ID, supplierInvoice } from "../../test/einvoice-fixtures.ts"
import { loadSigningKey, signXml } from "../einvoice/signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "../einvoice/xml.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Facturas de proveedores desde el XML", () => {
  let admin: User, employee: User
  let key: Awaited<ReturnType<typeof loadSigningKey>>
  const signed = async (d: EInvoiceData) => signXml(buildEInvoiceXml(d), key)
  const files = (r: request.Test, list: [string, string][]) => list.reduce((acc, [name, xml]) => acc.attach("files", Buffer.from(xml, "utf8"), name), r)
  const preview = (who: User, list: [string, string][]) => files(request(app).post("/payables/invoices/xml/preview").set(who.auth), list)
  const register = (who: User, list: [string, string][], fields: Record<string, string> = {}) => {
    const r = request(app).post("/payables/invoices/xml").set(who.auth)
    for (const [k, v] of Object.entries(fields)) r.field(k, v)
    return files(r, list)
  }

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    employee = await createUser("EMPLOYE", admin.companyId)
    await prisma.company.update({ where: { id: admin.companyId }, data: { idType: "JURIDICA", idNumber: COMPANY_ID } })
    key = await loadSigningKey(makeP12("1234", `CPJ-${SUPPLIER_ID}`, "DISTRIBUIDORA DE PRUEBA"), "1234")
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("la vista previa lee la factura: proveedor, IVA por tarifa, vencimiento según el plazo y la respuesta de Hacienda", async () => {
    const data = supplierInvoice()
    const xml = await signed(data)
    // el orden de los archivos da igual
    const res = await preview(admin, [["respuesta.xml", answerXml(data.clave, "1")], ["factura.xml", xml]])
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      kind: "INVOICE", clave: data.clave, number: data.consecutive, issueDate: "2026-11-10", dueDate: "2026-12-10", creditDays: 30,
      supplier: { name: "Distribuidora de Prueba S.A.", idType: "JURIDICA", idNumber: SUPPLIER_ID, email: "ventas@distribuidora.cr", existing: null },
      taxes: [{ rate: "RATE_13", base: 5800, tax: 754 }, { rate: "RATE_1", base: 1000, tax: 10 }],
      total: 7564, haciendaStatus: "Aceptado", creditable: true, notices: [], canImport: true,
    })
    expect(res.body.lines[0]).toMatchObject({ cabys: "4292199990200", description: "Martillo de uña 16 oz", quantity: 2, unit: "Unid", unitPrice: 3000, discount: 200, subtotal: 5800, rate: "RATE_13", tax: 754 })
    // sin la respuesta de Hacienda se puede, con un aviso
    const alone = await preview(admin, [["factura.xml", xml]])
    expect(alone.body.notices.map((n: { code: string }) => n.code)).toEqual(["NO_ANSWER"])
    expect(alone.body.canImport).toBe(true)
    expect((await preview(employee, [["factura.xml", xml]])).status).toBe(403) // payables.manage
  })

  it("al registrar crea el proveedor y la factura en Cuentas por pagar; no se importa dos veces", async () => {
    const data = supplierInvoice()
    const xml = await signed(data)
    const res = await register(admin, [["factura.xml", xml], ["respuesta.xml", answerXml(data.clave, "1")]], { note: "Pedido de noviembre" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ number: data.consecutive, total: 7564, creditable: true, clave: data.clave, haciendaStatus: "Aceptado" })
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: res.body.supplierId } })
    expect(supplier).toMatchObject({ name: "Distribuidora de Prueba S.A.", idType: "JURIDICA", idNumber: SUPPLIER_ID, email: "ventas@distribuidora.cr", phone: "22221111", creditDays: 30 })
    const invoice = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: res.body.id }, include: { taxes: true } })
    expect(invoice.xml).toBe(xml)
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe("2026-12-10")
    expect(invoice.taxes.map((t) => [t.rate, Number(t.base), Number(t.tax)]).sort()).toEqual([["RATE_1", 1000, 10], ["RATE_13", 5800, 754]])
    // queda en el estado de cuenta del proveedor
    const account = await request(app).get(`/payables/${supplier.id}`).set(admin.auth)
    expect(account.body.balance).toBe(7564)

    // la misma factura otra vez: bloqueada
    const again = await preview(admin, [["factura.xml", xml]])
    expect(again.body).toMatchObject({ canImport: false, duplicateId: res.body.id, supplier: { existing: { id: supplier.id } } })
    expect((await register(admin, [["factura.xml", xml]])).body.error).toMatch(/ya está registrada/)

    // otra factura del mismo proveedor: usa el proveedor que ya existe
    const second = await register(admin, [["factura.xml", await signed(supplierInvoice())]])
    expect(second.body.supplierId).toBe(supplier.id)
    expect(await prisma.supplier.count({ where: { idNumber: SUPPLIER_ID } })).toBe(1)
  })

  it("avisa lo que hay que revisar y bloquea lo que no se puede registrar", async () => {
    // a nombre de otra persona: se puede, pero no da crédito fiscal
    const other = await preview(admin, [["f.xml", await signed(supplierInvoice({ receiver: { name: "Juan Pérez", idType: "FISICA", idNumber: "112345678" } }))]])
    expect(other.body.notices.map((n: { code: string }) => n.code)).toContain("OTHER_RECEIVER")
    expect(other.body).toMatchObject({ creditable: false, canImport: true })

    // XML modificado después de firmado: aviso de firma
    const tampered = (await signed(supplierInvoice())).replace("Arroz precocido", "Arroz premium")
    expect((await preview(admin, [["f.xml", tampered]])).body.notices.map((n: { code: string }) => n.code)).toContain("SIGNATURE")

    // rechazada por Hacienda: no se registra
    const data = supplierInvoice()
    const rejected = await register(admin, [["f.xml", await signed(data)], ["r.xml", answerXml(data.clave, "3")]])
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toMatch(/RECHAZÓ/)

    // respuesta de otra factura: se ignora con aviso
    const mixed = await preview(admin, [["f.xml", await signed(supplierInvoice())], ["r.xml", answerXml(data.clave, "1")]])
    expect(mixed.body.notices.map((n: { code: string }) => n.code)).toEqual(expect.arrayContaining(["ANSWER_OTHER", "NO_ANSWER"]))

    // en dólares: se pasa a colones con su tipo de cambio
    const usd = await preview(admin, [["f.xml", await signed(supplierInvoice({ currency: "USD", exchangeRate: 500 }))]])
    expect(usd.body.taxes).toEqual([{ rate: "RATE_13", base: 2900000, tax: 377000 }, { rate: "RATE_1", base: 500000, tax: 5000 }])
    expect(usd.body.notices.map((n: { code: string }) => n.code)).toContain("CURRENCY")

    // archivos que no sirven
    expect((await preview(admin, [["r.xml", answerXml(data.clave, "1")]])).body.error).toMatch(/Falta el XML de la factura/)
    expect((await preview(admin, [["f.xml", "<hola>"]])).status).toBe(422)
    const note = buildEInvoiceXml(supplierInvoice({ type: "CREDIT_NOTE", reference: { type: "INVOICE", clave: data.clave, issuedAt: data.issuedAt, code: "06", reason: "Devolución" } }))
    expect((await preview(admin, [["n.xml", note]])).body.error).toMatch(/nota de crédito/)
    expect((await request(app).post("/payables/invoices/xml/preview").set(admin.auth)).body.error).toMatch(/Sube el XML/)
  })
})

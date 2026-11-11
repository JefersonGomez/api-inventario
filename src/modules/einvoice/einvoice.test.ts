// Bloque 9, fase 1: clave, XML v4.4 válido contra el XSD oficial, firma XAdES y envío/consulta a Hacienda.
// Hacienda se simula (fetch): las pruebas no salen a internet. La llave .p12 se genera en la prueba.
import { jest } from "@jest/globals"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import forge from "node-forge"
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"
import { buildClave, crDateTime } from "./clave.ts"
import { loadSigningKey, signXml, verifyXml } from "./signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "./xml.ts"
import { validateEInvoiceXml } from "./xsd-validate.ts"

type User = Awaited<ReturnType<typeof createUser>>
const HOLDER = "112340567" // cédula física del titular de la llave de prueba

// Llave .p12 de prueba (autofirmada) con la cédula en el serialNumber, como las de Hacienda
function makeP12(pin: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = "01"
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const subject = [{ name: "commonName", value: "PERSONA DE PRUEBA" }, { name: "serialNumber", value: "CPF-01-1234-0567" }]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: "3des" })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary")
}

const sample = (over: Partial<EInvoiceData> = {}): EInvoiceData => {
  const issuedAt = new Date("2026-11-10T22:15:00Z")
  const consecutive = "00100001040000000007"
  return {
    type: "TICKET", clave: buildClave({ issuedAt, idNumber: HOLDER, consecutive, code: "12345678" }), consecutive, issuedAt,
    provider: HOLDER, activity: "4752.0",
    emitter: { name: "Ferretería de Prueba", idType: "FISICA", idNumber: HOLDER, province: "1", canton: "01", district: "01", address: "Frente al parque", email: "ventas@prueba.cr", phone: "2222-3333" },
    currency: "CRC", saleCondition: "CASH",
    lines: [
      { cabys: "4292199990200", quantity: 2, unit: "UNIT", description: "Martillo <uña> & mango", unitPrice: "1000", discount: "100", discountLabel: "Cliente frecuente", taxRate: "RATE_13", subtotal: "1900", taxAmount: "247" },
      { cabys: "0111100000100", quantity: "1.5", unit: "KG", description: "Arroz", unitPrice: "500", discount: 0, taxRate: "EXEMPT", subtotal: "750", taxAmount: 0 },
    ],
    payments: [{ method: "CASH", amount: 2897 }],
    ...over,
  }
}

describe("Facturación electrónica — fase 1", () => {
  const pin = "12#34"
  let p12Path: string
  let admin: User, other: User
  let documentId: string
  const savedEnv = { ...process.env }

  beforeAll(async () => {
    p12Path = join(mkdtempSync(join(tmpdir(), "einv-")), "llave.p12")
    writeFileSync(p12Path, makeP12(pin))
    Object.assign(process.env, {
      HACIENDA_ENV: "pruebas", HACIENDA_USER: "cpf-01-1234-0567@stag.comprobanteselectronicos.go.cr",
      HACIENDA_PASSWORD: "secreto", HACIENDA_P12_PATH: p12Path, HACIENDA_P12_PIN: pin,
    })
    await resetDb()
    admin = await createUser("ADMIN")
    other = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    const cashier = await createUser("CASHIER", c)
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "MRT", name: "Martillo", price: 1130, stock: 10, minStock: 0, categoryId: category.id, locationId: main, cabys: "4292199990200" })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
    const sale = await request(app).post("/pos/sales").set(cashier.auth).send({ lines: [{ productId, quantity: 2 }], payments: [{ method: "CASH", amount: 2260 }] })
    documentId = sale.body.document.id
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    process.env = savedEnv
    await resetDb()
    await prisma.$disconnect()
  })

  it("clave de 50 dígitos con la fecha de Costa Rica", () => {
    // 03:00 UTC del 11-nov = 21:00 del 10-nov en Costa Rica
    expect(crDateTime(new Date("2026-11-11T03:00:00Z"))).toBe("2026-11-10T21:00:00-06:00")
    const clave = buildClave({ issuedAt: new Date("2026-11-11T03:00:00Z"), idNumber: "3101123456", consecutive: "00100001040000000007", code: "87654321" })
    expect(clave).toBe("506101126003101123456001000010400000000071" + "87654321")
    expect(clave).toHaveLength(50)
    expect(() => buildClave({ issuedAt: new Date(), idNumber: "1", consecutive: "123" })).toThrow(/20 dígitos/)
  })

  it("el tiquete cumple el XSD oficial v4.4 y la firma XAdES se verifica", async () => {
    const key = await loadSigningKey(makeP12("1234"), "1234")
    expect(key.holderId).toBe(HOLDER)
    await expect(loadSigningKey(makeP12("1234"), "9999")).rejects.toThrow(/PIN/)
    const xml = buildEInvoiceXml(sample())
    expect(xml).toContain("<Detalle>Martillo &lt;uña&gt; &amp; mango</Detalle>")
    expect(xml).toContain("<UnidadMedida>Kg</UnidadMedida>")
    expect(xml).toContain("<TotalComprobante>2897.00000</TotalComprobante>")
    const signed = await signXml(xml, key)
    expect(await validateEInvoiceXml("TICKET", signed)).toEqual([])
    expect(signed).toContain("DWxin1xWOeI8OuWQXazh4VjLWAaCLAA954em7DMh0h8=") // política de Hacienda
    expect(await verifyXml(signed)).toBe(true)
    expect(await verifyXml(signed.replace("Arroz", "Frijol"))).toBe(false)
    expect(() => buildEInvoiceXml(sample({ lines: [{ ...sample().lines[0]!, cabys: "" }] }))).toThrow(/CABYS/)
  })

  it("enviar: pide los datos fiscales y que la llave sea de la empresa", async () => {
    const send = () => request(app).post(`/einvoice/documents/${documentId}/send`).set(admin.auth)
    expect((await send()).body.code).toBe("EINVOICE_FISCAL_DATA")
    const fiscal = { legalName: "Ferretería de Prueba", economicActivity: "4752.0", province: "1", canton: "01", district: "01", addressDetail: "Frente al parque", invoiceEmail: "ventas@prueba.cr" }
    await request(app).put("/company").set(admin.auth).send({ ...fiscal, idType: "JURIDICA", idNumber: "3101123456" })
    expect((await send()).body.code).toBe("EINVOICE_KEY_MISMATCH")
    await request(app).put("/company").set(admin.auth).send({ idType: "FISICA", idNumber: HOLDER })
    expect(await prisma.eInvoice.count()).toBe(0)
  })

  it("envía a Hacienda, guarda el XML firmado y consulta la respuesta", async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    const answer = Buffer.from("<MensajeHacienda><DetalleMensaje>Aceptado en pruebas</DetalleMensaje></MensajeHacienda>").toString("base64")
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : "" })
      if (url.includes("/token")) return Response.json({ access_token: "tkn", expires_in: 300 })
      if (init?.method === "POST") return new Response(null, { status: 202 })
      return Response.json({ "ind-estado": "aceptado", "respuesta-xml": answer })
    })

    const sent = await request(app).post(`/einvoice/documents/${documentId}/send`).set(admin.auth)
    expect(sent.status).toBe(200)
    expect(sent.body).toMatchObject({ status: "SENT", environment: "pruebas", attempts: 1, lastError: null })
    expect(sent.body.clave).toMatch(new RegExp(`^506\\d{6}000${HOLDER}\\d{20}1\\d{8}$`))
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/recepcion"))!
    expect(post.url).toContain("api-sandbox")
    const payload = JSON.parse(post.body!)
    expect(payload).toMatchObject({ clave: sent.body.clave, emisor: { tipoIdentificacion: "01", numeroIdentificacion: HOLDER } })
    const signed = Buffer.from(payload.comprobanteXml, "base64").toString("utf8")
    expect(await validateEInvoiceXml("TICKET", signed)).toEqual([])
    expect(await verifyXml(signed)).toBe(true)
    expect(JSON.stringify(calls)).not.toContain(process.env.HACIENDA_P12_PIN)

    // reenviar no arma otro comprobante: consulta el estado
    const again = await request(app).post(`/einvoice/documents/${documentId}/send`).set(admin.auth)
    expect(again.body).toMatchObject({ clave: sent.body.clave, status: "ACCEPTED", message: "Aceptado en pruebas" })
    expect(await prisma.eInvoice.count()).toBe(1)
    const xml = await request(app).get(`/einvoice/documents/${documentId}/xml`).set(admin.auth)
    expect(xml.headers["content-type"]).toMatch(/xml/)
    expect(xml.text).toBe(signed)
    expect((await request(app).get(`/einvoice/documents/${documentId}`).set(admin.auth)).body.status).toBe("ACCEPTED")
    // otra empresa no lo ve
    expect((await request(app).get(`/einvoice/documents/${documentId}`).set(other.auth)).status).toBe(404)
  })
})

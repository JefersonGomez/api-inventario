// Bloque 9: clave, XML v4.4 válido contra el XSD oficial, firma XAdES, configuración cifrada por empresa,
// envío automático con reintentos y consulta de respuestas.
// Hacienda se simula (fetch): las pruebas no salen a internet. La llave .p12 se genera en la prueba.
import { jest } from "@jest/globals"
import forge from "node-forge"
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"
import { buildClave, crDateTime } from "./clave.ts"
import { loadSigningKey, signXml, verifyXml } from "./signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "./xml.ts"
import { validateEInvoiceXml } from "./xsd-validate.ts"
import { processEInvoices } from "./einvoice.service.ts"

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

describe("Facturación electrónica", () => {
  const PIN = "12#34"
  const p12 = makeP12(PIN)
  let admin: User, cashier: User, other: User
  let productId: string, noCabysId: string, beforeEnabledId: string
  // Hacienda simulada: lo que se llamó y cómo responde cada cosa
  const calls: { url: string; method: string; body: string }[] = []
  const hacienda = { token: true, post: 202, state: "aceptado" }
  const answer = Buffer.from("<MensajeHacienda><DetalleMensaje>Aceptado en pruebas</DetalleMensaje></MensajeHacienda>").toString("base64")
  const sell = async (id: string) => (await request(app).post("/pos/sales").set(cashier.auth)
    .send({ lines: [{ productId: id, quantity: 1 }], payments: [{ method: "CASH", amount: 1130 }] })).body.document.id as string
  const settings = (fields: Record<string, string>, withKey = false, who: User = admin) => {
    const r = request(app).put("/einvoice/settings").set(who.auth)
    for (const [k, v] of Object.entries(fields)) r.field(k, v)
    return withKey ? r.attach("p12", p12, "llave.p12") : r
  }
  const einvoiceOf = (documentId: string) => prisma.eInvoice.findUnique({ where: { documentId } })
  const until = async (fn: () => Promise<unknown>) => {
    for (let i = 0; i < 40 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 50))
  }

  beforeAll(async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : "" })
      if (url.includes("/token")) {
        return hacienda.token ? Response.json({ access_token: "tkn", expires_in: 300 }) : Response.json({ error_description: "Invalid user credentials" }, { status: 401 })
      }
      if (init?.method === "POST") return new Response(null, { status: hacienda.post, headers: hacienda.post >= 400 ? { "X-Error-Cause": "Falla simulada" } : {} })
      return Response.json({ "ind-estado": hacienda.state, "respuesta-xml": answer })
    })
    await resetDb()
    admin = await createUser("ADMIN")
    other = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    cashier = await createUser("CASHIER", c)
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const product = (body: object) => request(app).post("/products").set(admin.auth)
      .send({ price: 1130, stock: 50, minStock: 0, categoryId: category.id, locationId: main, ...body })
    productId = (await product({ sku: "MRT", name: "Martillo", cabys: "4292199990200" })).body.id
    noCabysId = (await product({ sku: "SIN", name: "Sin CABYS" })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
    beforeEnabledId = await sell(productId)
  })

  afterAll(async () => {
    jest.restoreAllMocks()
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

  it("configuración: la llave debe abrir con su PIN y ser de la empresa; los secretos quedan cifrados", async () => {
    expect((await request(app).get("/einvoice/settings").set(admin.auth)).body).toMatchObject({ configured: false, enabled: false, secretReady: true })
    expect((await request(app).get("/einvoice/settings").set(cashier.auth)).status).toBe(403)
    expect((await settings({ pin: PIN }, true)).body.code).toBe("EINVOICE_FISCAL_DATA") // la empresa sin identificación
    await request(app).put("/company").set(admin.auth).send({ idType: "JURIDICA", idNumber: "3101123456" })
    expect((await settings({ pin: "0000" }, true)).body.code).toBe("EINVOICE_PIN")
    expect((await settings({ pin: PIN }, true)).body.code).toBe("EINVOICE_KEY_MISMATCH")
    await request(app).put("/company").set(admin.auth).send({ idType: "FISICA", idNumber: HOLDER })

    hacienda.token = false
    expect((await settings({ username: "cpf@stag", password: "mala" })).body.code).toBe("EINVOICE_CREDENTIALS")
    hacienda.token = true
    const saved = await settings({ environment: "pruebas", username: "cpf@stag", password: "la-clave", pin: PIN }, true)
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ configured: true, enabled: false, hasPassword: true, key: { holderId: HOLDER, holderName: "PERSONA DE PRUEBA" } })
    expect(JSON.stringify(saved.body)).not.toMatch(/la-clave|12#34/)
    const row = await prisma.eInvoiceSettings.findUniqueOrThrow({ where: { companyId: admin.companyId } })
    expect(row.passwordEnc).toMatch(/^v1:/)
    expect([row.passwordEnc, row.pinEnc, row.p12Enc].join()).not.toMatch(/la-clave|12#34/)
    const audit = await prisma.auditLog.findMany({ where: { entityType: "EInvoiceSettings" } })
    expect(audit.length).toBeGreaterThan(0)
    expect(JSON.stringify(audit)).not.toMatch(/la-clave|12#34/)
    expect((await request(app).post("/einvoice/settings/test").set(admin.auth)).body).toMatchObject({ ok: true, environment: "pruebas" })
    // otra empresa no ve esta configuración
    expect((await request(app).get("/einvoice/settings").set(other.auth)).body.configured).toBe(false)
  })

  it("encender pide los datos fiscales; desde ahí cada tiquete se envía solo y se consulta la respuesta", async () => {
    expect((await settings({ enabled: "true" })).body.code).toBe("EINVOICE_FISCAL_DATA")
    await request(app).put("/company").set(admin.auth).send({
      legalName: "Ferretería de Prueba", economicActivity: "4752.0", province: "4", canton: "10", district: "03",
      addressDetail: "La Victoria, frente a la escuela", invoiceEmail: "ventas@prueba.cr",
    })
    const on = await settings({ enabled: "true" })
    expect(on.body).toMatchObject({ enabled: true })

    const id = await sell(productId)
    await until(async () => (await einvoiceOf(id))?.status === "SENT")
    const e = (await einvoiceOf(id))!
    expect(e).toMatchObject({ status: "SENT", environment: "pruebas", attempts: 1 })
    const post = calls.find((c) => c.method === "POST" && c.body.includes(e.clave!))!
    const signed = Buffer.from(JSON.parse(post.body).comprobanteXml, "base64").toString("utf8")
    expect(await validateEInvoiceXml("TICKET", signed)).toEqual([])
    expect(await verifyXml(signed)).toBe(true)
    expect(signed).toContain("<CodigoActividadEmisor>4752.0</CodigoActividadEmisor>")

    // la respuesta se consulta en el repaso (lo enviado hace más de 20 s)
    await prisma.eInvoice.update({ where: { id: e.id }, data: { sentAt: new Date(Date.now() - 60_000) } })
    await processEInvoices()
    expect(await einvoiceOf(id)).toMatchObject({ status: "ACCEPTED", message: "Aceptado en pruebas" })
    expect(await einvoiceOf(beforeEnabledId)).toBeNull() // lo vendido antes de encender no se manda solo

    // Ventas muestra el estado
    const list = (await request(app).get("/sales").set(admin.auth)).body.items as { id: string; einvoice: { status: string } | null }[]
    expect(list.find((s) => s.id === id)?.einvoice).toEqual({ status: "ACCEPTED" })
    expect((await request(app).get(`/sales/${id}`).set(admin.auth)).body.einvoice).toMatchObject({ status: "ACCEPTED", clave: e.clave })
    expect((await request(app).get(`/einvoice/documents/${id}/xml`).set(admin.auth)).text).toBe(signed)
    expect((await request(app).get(`/einvoice/documents/${id}`).set(other.auth)).status).toBe(404)
  })

  it("si Hacienda no responde se reintenta con espera; si falta el CABYS queda en error y avisa", async () => {
    hacienda.post = 503
    const id = await sell(productId)
    await until(async () => ((await einvoiceOf(id))?.attempts ?? 0) > 0)
    const failed = (await einvoiceOf(id))!
    expect(failed).toMatchObject({ status: "PENDING", attempts: 1, lastError: "Falla simulada" })
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    await processEInvoices() // todavía no toca reintentar
    expect((await einvoiceOf(id))!.attempts).toBe(1)
    hacienda.post = 202
    await prisma.eInvoice.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    await processEInvoices()
    expect(await einvoiceOf(id)).toMatchObject({ status: "SENT", attempts: 2, lastError: null, clave: failed.clave })

    const bad = await sell(noCabysId)
    await until(async () => (await einvoiceOf(bad))?.status === "ERROR")
    expect((await einvoiceOf(bad))!.lastError).toMatch(/CABYS/)
    const notes = await prisma.notification.findMany({ where: { type: "einvoiceProblem", userId: admin.user.id } })
    expect(notes).toEqual([expect.objectContaining({ link: `/sales/${bad}`, meta: expect.objectContaining({ status: "ERROR" }) })])
    // reintentar a mano sin corregir el dato: el mismo error, y no se repite el aviso
    expect((await request(app).post(`/einvoice/documents/${bad}/send`).set(admin.auth)).body.code).toBe("EINVOICE_DATA")
    expect(await prisma.notification.count({ where: { type: "einvoiceProblem", userId: admin.user.id } })).toBe(1)

    // apagar el envío automático
    expect((await settings({ enabled: "false" })).body).toMatchObject({ enabled: false, enabledAt: null })
    const off = await sell(productId)
    await processEInvoices()
    expect(await einvoiceOf(off)).toBeNull()
  })
})

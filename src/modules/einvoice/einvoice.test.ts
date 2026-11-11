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
import { cleanHaciendaMessage } from "./hacienda.client.ts"

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
  const mail = { ok: true } // Resend simulado
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
      if (url.startsWith("https://api.resend.com")) return mail.ok ? Response.json({ id: "correo-1" }) : new Response("caído", { status: 500 })
      if (url.startsWith("https://api.hacienda.go.cr/fe/ae")) {
        return url.endsWith("=3101123456")
          ? Response.json({ nombre: "CONSTRUCTORA  LOS PINOS SOCIEDAD ANONIMA", tipoIdentificacion: "02", situacion: { estado: "Inscrito" }, actividades: [{ estado: "A", codigo: "4100.0", descripcion: "Construcción" }, { estado: "I", codigo: "1", descripcion: "x" }] })
          : new Response(null, { status: 404 })
      }
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

  it("el rechazo de Hacienda se limpia: sin el aviso de pruebas, solo el motivo con su código", () => {
    const raw = [
      "Este comprobante fue recibido en el ambiente de pruebas, por lo cual no tiene validez para fines tributarios.&#13;",
      "",
      "El comprobante electrónico tiene los siguientes errores: ",
      "[",
      "codigo, mensaje, fila, columna",
      `-400, "En la línea (1) el código ""X"" no existe", 0, 0`,
      `-37, "Ubicación inválida", 0, 0`,
      "]",
    ].join("\n")
    expect(cleanHaciendaMessage(raw)).toBe(`En la línea (1) el código "X" no existe (código -400)\nUbicación inválida (código -37)`)
    expect(cleanHaciendaMessage("Este comprobante fue recibido en el ambiente de pruebas, por lo cual no tiene validez.\nAceptado")).toBe("Aceptado")
    // así llega de verdad: el mensaje entre comillas dobles y &#13; al final de cada fila
    const real = [
      "Este comprobante fue recibido en el ambiente de pruebas, por lo cual no tiene validez para fines tributarios.",
      "",
      "El comprobante electrónico tiene los siguientes errores: &#13;",
      "[&#13;",
      "codigo, mensaje, fila, columna&#13;",
      `-400, ""En la línea (1) el código no se encuentra en el Catálogo CAByS, por favor verifique"", 0, 0&#13;`,
      "&#13;",
      "]",
    ].join("\n")
    expect(cleanHaciendaMessage(real)).toBe("En la línea (1) el código no se encuentra en el Catálogo CAByS, por favor verifique (código -400)")
    expect(cleanHaciendaMessage(null)).toBeNull()
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

  it("la factura lleva al cliente (Receptor) y cumple el XSD oficial, también a crédito y con cliente extranjero", async () => {
    const key = await loadSigningKey(makeP12("1234"), "1234")
    const invoice = (over: Partial<EInvoiceData>) => sample({ type: "INVOICE", consecutive: "00100001010000000007", ...over })
    const receiver = { name: "Constructora <Los Pinos> S.A.", idType: "JURIDICA" as const, idNumber: "3-101-123456", email: "compras@pinos.cr" }
    const xml = buildEInvoiceXml(invoice({ receiver }))
    expect(xml).toContain("<FacturaElectronica xmlns=\"https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica\"")
    expect(xml).toContain("<Receptor><Nombre>Constructora &lt;Los Pinos&gt; S.A.</Nombre><Identificacion><Tipo>02</Tipo><Numero>3101123456</Numero></Identificacion><CorreoElectronico>compras@pinos.cr</CorreoElectronico></Receptor>")
    expect(await validateEInvoiceXml("INVOICE", await signXml(xml, key))).toEqual([])
    // a crédito y sin pagos: lleva el plazo y ningún medio de pago
    const credit = buildEInvoiceXml(invoice({ receiver, saleCondition: "CREDIT", creditDays: 30, payments: [] }))
    expect(credit).toContain("<CondicionVenta>02</CondicionVenta><PlazoCredito>30</PlazoCredito>")
    expect(credit).not.toContain("<MedioPago>")
    expect(await validateEInvoiceXml("INVOICE", await signXml(credit, key))).toEqual([])
    // extranjero (05) y sin correo
    const foreign = buildEInvoiceXml(invoice({ receiver: { name: "John Smith", idType: "EXTRANJERO", idNumber: "P1234567", email: "" } }))
    expect(foreign).toContain("<Identificacion><Tipo>05</Tipo><Numero>P1234567</Numero></Identificacion></Receptor>")
    expect(await validateEInvoiceXml("INVOICE", await signXml(foreign, key))).toEqual([])
    // nota de crédito: referencia al comprobante original (clave, fecha, código y motivo)
    const original = sample()
    const note = buildEInvoiceXml(sample({
      type: "CREDIT_NOTE", consecutive: "00100001030000000001",
      reference: { type: "TICKET", clave: original.clave, issuedAt: original.issuedAt, code: "06", reason: "Producto <dañado>" },
    }))
    expect(note).toContain(`<InformacionReferencia><TipoDocIR>04</TipoDocIR><Numero>${original.clave}</Numero><FechaEmisionIR>2026-11-10T16:15:00-06:00</FechaEmisionIR><Codigo>06</Codigo><Razon>Producto &lt;dañado&gt;</Razon></InformacionReferencia></NotaCreditoElectronica>`)
    expect(await validateEInvoiceXml("CREDIT_NOTE", await signXml(note, key))).toEqual([])
    // la nota de una factura lleva al cliente
    const invoiceNote = buildEInvoiceXml(sample({
      type: "CREDIT_NOTE", consecutive: "00100001030000000002", receiver,
      reference: { type: "INVOICE", clave: original.clave, issuedAt: original.issuedAt, code: "01", reason: "Anulación" },
    }))
    expect(invoiceNote).toContain("<Receptor>")
    expect(await validateEInvoiceXml("CREDIT_NOTE", await signXml(invoiceNote, key))).toEqual([])
    expect(() => buildEInvoiceXml(sample({ type: "CREDIT_NOTE", reference: null }))).toThrow(/clave del comprobante/)
    // sin cliente no hay factura; el tiquete nunca lleva Receptor
    expect(() => buildEInvoiceXml(invoice({ receiver: null }))).toThrow(/cliente/)
    expect(buildEInvoiceXml(sample({ receiver }))).not.toContain("<Receptor>")
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

  it("con cliente identificado sale factura: se envía sola, y al aceptarse le llega por correo con los XML", async () => {
    process.env.RESEND_API_KEY = "re_prueba"
    process.env.EMAIL_FROM = "Stockly <facturas@prueba.cr>"
    try {
      // el nombre exacto se trae de Hacienda con la cédula
      const found = await request(app).get("/einvoice/taxpayer/3-101-123456").set(cashier.auth)
      expect(found.body).toEqual({
        idNumber: "3101123456", name: "CONSTRUCTORA LOS PINOS SOCIEDAD ANONIMA", idType: "JURIDICA", status: "Inscrito",
        activities: [{ code: "4100.0", description: "Construcción" }],
      })
      expect((await request(app).get("/einvoice/taxpayer/3101999999").set(cashier.auth)).body.code).toBe("TAXPAYER_NOT_FOUND")
      expect((await request(app).get("/einvoice/taxpayer/12").set(cashier.auth)).body.code).toBe("TAXPAYER_ID")

      const customer = (await request(app).post("/customers").set(admin.auth)
        .send({ name: found.body.name, idType: "JURIDICA", idNumber: "3101123456", email: "compras@pinos.cr" })).body
      const sale = await request(app).post("/pos/sales").set(cashier.auth)
        .send({ customerId: customer.id, lines: [{ productId, quantity: 1 }], payments: [{ method: "CARD", amount: 1130, reference: "AUT-778899" }] })
      expect(sale.body).toMatchObject({ document: { type: "INVOICE" } })
      const id = sale.body.document.id as string
      await until(async () => (await einvoiceOf(id))?.status === "SENT")
      const e = (await einvoiceOf(id))!
      const post = calls.find((c) => c.method === "POST" && c.body.includes(e.clave!))!
      const signed = Buffer.from(JSON.parse(post.body).comprobanteXml, "base64").toString("utf8")
      expect(signed).toContain("<Receptor><Nombre>CONSTRUCTORA LOS PINOS SOCIEDAD ANONIMA</Nombre>")
      expect(await validateEInvoiceXml("INVOICE", signed)).toEqual([])

      // aceptada → correo al cliente con el XML firmado y la respuesta de Hacienda
      await prisma.eInvoice.update({ where: { id: e.id }, data: { sentAt: new Date(Date.now() - 60_000) } })
      await processEInvoices()
      const done = (await einvoiceOf(id))!
      expect(done).toMatchObject({ status: "ACCEPTED", emailedTo: "compras@pinos.cr", emailError: null })
      const email = JSON.parse(calls.filter((c) => c.url.startsWith("https://api.resend.com")).at(-1)!.body)
      expect(email).toMatchObject({ to: "compras@pinos.cr", from: "Stockly <facturas@prueba.cr>" })
      expect(email.subject).toMatch(/^Factura electrónica 0010000101/)
      expect(email.attachments.map((a: { filename: string }) => a.filename)).toEqual([`${e.clave}.xml`, `${e.clave}-respuesta-hacienda.xml`])
      expect(Buffer.from(email.attachments[0].content, "base64").toString("utf8")).toBe(signed)
      expect((await request(app).get(`/sales/${id}`).set(admin.auth)).body.einvoice).toMatchObject({ emailedTo: "compras@pinos.cr" })

      // si el correo falla queda el motivo y se reenvía desde la venta
      mail.ok = false
      expect((await request(app).post(`/einvoice/documents/${id}/email`).set(admin.auth)).body.code).toBe("EINVOICE_EMAIL")
      expect((await einvoiceOf(id))!.emailError).toMatch(/No se pudo enviar el correo/)
      mail.ok = true
      const again = await request(app).post(`/einvoice/documents/${id}/email`).set(admin.auth)
      expect(again.body).toMatchObject({ emailedTo: "compras@pinos.cr", emailError: null })
      expect((await request(app).post(`/einvoice/documents/${id}/email`).set(cashier.auth)).status).toBe(403)

      // cliente identificado sin correo: la factura sale igual y queda anotado que no se pudo entregar
      const noMail = (await request(app).post("/customers").set(admin.auth).send({ name: "Ana Mora", idType: "FISICA", idNumber: "105550555" })).body
      const id2 = (await request(app).post("/pos/sales").set(cashier.auth)
        .send({ customerId: noMail.id, lines: [{ productId, quantity: 1 }], payments: [{ method: "CASH", amount: 1130 }] })).body.document.id as string
      await until(async () => (await einvoiceOf(id2))?.status === "SENT")
      await prisma.eInvoice.update({ where: { documentId: id2 }, data: { sentAt: new Date(Date.now() - 60_000) } })
      await processEInvoices()
      expect(await einvoiceOf(id2)).toMatchObject({ status: "ACCEPTED", emailedTo: null, emailError: expect.stringMatching(/no tiene un correo/) })
    } finally {
      delete process.env.RESEND_API_KEY
      delete process.env.EMAIL_FROM
    }
  })

  it("la devolución sale como nota de crédito a Hacienda, solo cuando la venta original ya está aceptada", async () => {
    const manager = await createUser("MANAGER", admin.companyId) // encargado que autoriza la devolución con su código
    await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })
    const sale = await request(app).post("/pos/sales").set(cashier.auth)
      .send({ lines: [{ productId, quantity: 2 }], payments: [{ method: "CASH", amount: 2260 }] })
    const saleId = sale.body.document.id as string
    const lineId = sale.body.document.lines[0].id as string
    await until(async () => (await einvoiceOf(saleId))?.status === "SENT")
    const original = (await einvoiceOf(saleId))!

    // devuelve 1 de 2 mientras Hacienda todavía no responde la venta: la nota espera
    const ret = await request(app).post(`/sales/${saleId}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId, quantity: 1, condition: "GOOD" }], reason: "No le sirvió", refund: { method: "CASH" }, pin: "5937" })
    expect(ret.status).toBe(201)
    const noteId = ret.body.document.id as string
    await new Promise((r) => setTimeout(r, 200))
    expect(await einvoiceOf(noteId)).toBeNull()
    expect((await request(app).get(`/sales/${noteId}`).set(admin.auth)).body).toMatchObject({ einvoice: null, referenceEInvoiceStatus: "SENT" })
    expect((await request(app).post(`/einvoice/documents/${noteId}/send`).set(admin.auth)).body.code).toBe("EINVOICE_REFERENCE")

    // Hacienda acepta la venta (primer repaso) y entonces sale la nota (siguiente repaso)
    await prisma.eInvoice.update({ where: { id: original.id }, data: { sentAt: new Date(Date.now() - 60_000) } })
    await processEInvoices()
    expect((await einvoiceOf(saleId))!.status).toBe("ACCEPTED")
    await processEInvoices()
    const note = (await einvoiceOf(noteId))!
    expect(note.status).toBe("SENT")
    const post = calls.find((c) => c.method === "POST" && c.body.includes(note.clave!))!
    const signed = Buffer.from(JSON.parse(post.body).comprobanteXml, "base64").toString("utf8")
    expect(signed).toContain("<NotaCreditoElectronica")
    expect(signed).toContain(`<TipoDocIR>04</TipoDocIR><Numero>${original.clave}</Numero>`)
    expect(signed).toContain("<Codigo>06</Codigo><Razon>No le sirvió</Razon>") // parcial = devolución de mercancía
    expect(signed).not.toContain("<Receptor>")
    expect(await validateEInvoiceXml("CREDIT_NOTE", signed)).toEqual([])
    // la venta muestra el estado de su nota
    const detail = (await request(app).get(`/sales/${saleId}`).set(admin.auth)).body
    expect(detail.creditNotes).toEqual([expect.objectContaining({ id: noteId, einvoice: { status: "SENT" } })])

    // devolver lo que queda de una venta que Hacienda nunca tuvo (vendida antes de encender): la nota no se manda
    const old = (await request(app).get(`/sales/${beforeEnabledId}`).set(admin.auth)).body
    const back = await request(app).post(`/sales/${beforeEnabledId}/returns`).set(cashier.auth)
      .send({ lines: [{ lineId: old.document.lines[0].id, quantity: 1, condition: "GOOD" }], reason: "Cambio de opinión", refund: { method: "CASH" }, pin: "5937" })
    await processEInvoices()
    expect(await einvoiceOf(back.body.document.id)).toBeNull()
    expect((await request(app).get(`/sales/${back.body.document.id}`).set(admin.auth)).body.referenceEInvoiceStatus).toBeNull()
  })

  it("la venta que la caja hizo sin internet va a Hacienda como situación 3, con la hora real de la venta", async () => {
    const soldAt = new Date(Date.now() - 2000) // dentro del turno abierto (la caja lo exige)
    const sale = await request(app).post("/pos/sales").set(cashier.auth).send({
      clientSaleId: "6f1e2d3c-4b5a-4987-8a1b-2c3d4e5f6a7b", soldAt: soldAt.toISOString(),
      lines: [{ productId, quantity: 1, seenPrice: 1130 }], payments: [{ method: "CASH", amount: 1130 }],
    })
    expect(sale.body).toMatchObject({ document: { offline: true } })
    const id = sale.body.document.id as string
    await until(async () => (await einvoiceOf(id))?.status === "SENT")
    const e = (await einvoiceOf(id))!
    expect(e.clave![41]).toBe("3") // situación: 3 = sin internet
    const signed = Buffer.from(JSON.parse(calls.find((c) => c.method === "POST" && c.body.includes(e.clave!))!.body).comprobanteXml, "base64").toString("utf8")
    expect(signed).toContain(`<FechaEmision>${crDateTime(soldAt)}</FechaEmision>`)
    // una venta normal sigue siendo situación 1
    const normal = await sell(productId)
    await until(async () => (await einvoiceOf(normal))?.status === "SENT")
    expect((await einvoiceOf(normal))!.clave![41]).toBe("1")
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
    // el estado se guarda antes que el aviso: se espera a los dos
    await until(async () => (await einvoiceOf(bad))?.status === "ERROR" && (await prisma.notification.count({ where: { type: "einvoiceProblem", userId: admin.user.id } })) > 0)
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

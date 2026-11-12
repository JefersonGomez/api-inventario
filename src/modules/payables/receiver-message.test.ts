// Mensaje receptor: responderle a Hacienda sobre la factura de un proveedor (Bloque 9, punto 48 — parte 2)
import { jest } from "@jest/globals"
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { COMPANY_ID, makeP12, SUPPLIER_ID, supplierInvoice } from "../../test/einvoice-fixtures.ts"
import { loadSigningKey, signXml } from "../einvoice/signer.ts"
import { buildEInvoiceXml, type EInvoiceData } from "../einvoice/xml.ts"
import { RECEIVER_MESSAGE_XSD, validateWithSchema } from "../einvoice/xsd-validate.ts"
import { processReceiverMessages } from "./receiver-message.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Mensaje receptor", () => {
  let admin: User, other: User
  let supplierKey: Awaited<ReturnType<typeof loadSigningKey>>
  const calls: { url: string; method: string; body: string }[] = []
  const hacienda = { state: "aceptado" }
  const sentBodies = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/recepcion")).map((c) => JSON.parse(c.body))
  const xmlOf = (body: { comprobanteXml: string }) => Buffer.from(body.comprobanteXml, "base64").toString("utf8")
  const signed = async (d: EInvoiceData) => signXml(buildEInvoiceXml(d), supplierKey)
  const importInvoice = (xml: string, fields: Record<string, string> = {}) => {
    const r = request(app).post("/payables/invoices/xml").set(admin.auth)
    for (const [k, v] of Object.entries(fields)) r.field(k, v)
    return r.attach("files", Buffer.from(xml, "utf8"), "factura.xml")
  }
  const messageOf = (invoiceId: string) => prisma.receiverMessage.findUnique({ where: { invoiceId } })
  const answered = async (invoiceId: string) => {
    await prisma.receiverMessage.update({ where: { invoiceId }, data: { sentAt: new Date(Date.now() - 60_000) } })
    await processReceiverMessages()
  }

  beforeAll(async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : "" })
      if (url.includes("/token")) return Response.json({ access_token: "tkn", expires_in: 300 })
      if (init?.method === "POST") return new Response(null, { status: 202 })
      const answer = Buffer.from(`<MensajeHacienda><DetalleMensaje>${hacienda.state === "aceptado" ? "Aceptado" : "Mensaje rechazado por prueba"}</DetalleMensaje></MensajeHacienda>`).toString("base64")
      return Response.json({ "ind-estado": hacienda.state, "respuesta-xml": answer })
    })
    await resetDb()
    admin = await createUser("ADMIN")
    other = await createUser("ADMIN")
    await prisma.company.update({
      where: { id: admin.companyId },
      data: { legalName: "Ferretería El Tornillo S.A.", idType: "JURIDICA", idNumber: COMPANY_ID, economicActivity: "4752.0" },
    })
    supplierKey = await loadSigningKey(makeP12("1234", `CPJ-${SUPPLIER_ID}`, "DISTRIBUIDORA DE PRUEBA"), "1234")
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await resetDb()
    await prisma.$disconnect()
  })

  it("sin la facturación configurada no se puede responder; la factura se registra igual", async () => {
    const xml = await signed(supplierInvoice())
    const preview = await request(app).post("/payables/invoices/xml/preview").set(admin.auth).attach("files", Buffer.from(xml), "f.xml")
    expect(preview.body.receiverReady).toBe(false)
    const res = await importInvoice(xml, { respond: "true" })
    expect(res.status).toBe(201)
    expect(res.body.respondError).toMatch(/no está configurada/)
    expect(await messageOf(res.body.id)).toBeNull()

    // configura la facturación con la llave de la empresa
    const p12 = makeP12("4321", `CPJ-${COMPANY_ID}`, "FERRETERIA EL TORNILLO")
    const saved = await request(app).put("/einvoice/settings").set(admin.auth)
      .field("environment", "pruebas").field("username", "cpj-3-101-999888@stag").field("password", "clave").field("pin", "4321")
      .attach("p12", p12, "llave.p12")
    expect(saved.status).toBe(200)
    // y responde después, desde la factura ya registrada
    const later = await request(app).post(`/payables/invoices/${res.body.id}/respond`).set(admin.auth).send({ decision: "ACCEPT" })
    expect(later.body).toMatchObject({ decision: "1", condition: "01", status: "SENT" })
  })

  it("aceptar al importar: firma el mensaje con su consecutivo, lo envía, acredita el IVA y queda aceptado", async () => {
    const data = supplierInvoice()
    const res = await importInvoice(await signed(data), { respond: "true" })
    expect(res.status).toBe(201)
    expect(res.body.receiverMessage).toMatchObject({ decision: "1", condition: "01", status: "SENT", environment: "pruebas", consecutive: "0010000105" + "0000000002" })

    const body = sentBodies().at(-1)!
    expect(body).toMatchObject({
      clave: data.clave, consecutivoReceptor: "00100001050000000002",
      emisor: { tipoIdentificacion: "02", numeroIdentificacion: SUPPLIER_ID }, receptor: { tipoIdentificacion: "02", numeroIdentificacion: COMPANY_ID },
    })
    const xml = xmlOf(body)
    expect(await validateWithSchema(RECEIVER_MESSAGE_XSD, xml)).toEqual([])
    expect(xml).toContain(`<Clave>${data.clave}</Clave><NumeroCedulaEmisor>${SUPPLIER_ID}</NumeroCedulaEmisor>`)
    expect(xml).toContain("<Mensaje>1</Mensaje><MontoTotalImpuesto>764.00000</MontoTotalImpuesto><CodigoActividad>4752.0</CodigoActividad><CondicionImpuesto>01</CondicionImpuesto><MontoTotalImpuestoAcreditar>764.00000</MontoTotalImpuestoAcreditar><MontoTotalDeGastoAplicable>6800.00000</MontoTotalDeGastoAplicable><TotalFactura>7564.00000</TotalFactura>")

    // la respuesta de Hacienda se consulta con la clave de la factura + el consecutivo del mensaje
    await answered(res.body.id)
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith(`/recepcion/${data.clave}-00100001050000000002`))).toBe(true)
    expect(await messageOf(res.body.id)).toMatchObject({ status: "ACCEPTED", message: "Aceptado" })
    // el estado de cuenta del proveedor muestra la respuesta
    const account = await request(app).get(`/payables/${res.body.supplierId}`).set(admin.auth)
    expect(account.body.invoices.find((i: { id: string }) => i.id === res.body.id).receiverMessage).toMatchObject({ decision: "1", status: "ACCEPTED" })
    // no se responde dos veces
    expect((await request(app).post(`/payables/invoices/${res.body.id}/respond`).set(admin.auth).send({ decision: "REJECT", detail: "Otra vez" })).body.error).toMatch(/Ya se le respondió/)
  })

  it("rechazar pide el motivo; sin crédito fiscal la condición es 04; si Hacienda rechaza el mensaje se responde de nuevo", async () => {
    const id = (await importInvoice(await signed(supplierInvoice()))).body.id as string
    expect((await request(app).post(`/payables/invoices/${id}/respond`).set(admin.auth).send({ decision: "REJECT" })).status).toBe(400)
    const rejected = await request(app).post(`/payables/invoices/${id}/respond`).set(admin.auth).send({ decision: "REJECT", detail: "Los precios no son los pactados" })
    expect(rejected.body).toMatchObject({ decision: "3", condition: null, consecutive: "00100001070000000001" })
    const xml = xmlOf(sentBodies().at(-1)!)
    expect(xml).toContain("<Mensaje>3</Mensaje><DetalleMensaje>Los precios no son los pactados</DetalleMensaje>")
    expect(xml).not.toContain("CondicionImpuesto")
    expect(await validateWithSchema(RECEIVER_MESSAGE_XSD, xml)).toEqual([])

    // a nombre de otra persona: se acepta como gasto que no genera crédito (04, nada que acreditar)
    const notMine = await importInvoice(await signed(supplierInvoice({ receiver: { name: "Juan Pérez", idType: "FISICA", idNumber: "112345678" } })))
    expect(notMine.body.creditable).toBe(false)
    const accepted = await request(app).post(`/payables/invoices/${notMine.body.id}/respond`).set(admin.auth).send({ decision: "ACCEPT" })
    expect(accepted.body).toMatchObject({ condition: "04" })
    expect(xmlOf(sentBodies().at(-1)!)).toContain("<CondicionImpuesto>04</CondicionImpuesto><MontoTotalImpuestoAcreditar>0.00000</MontoTotalImpuestoAcreditar><MontoTotalDeGastoAplicable>7564.00000</MontoTotalDeGastoAplicable>")

    // Hacienda rechaza el mensaje: avisa y deja responder otra vez (con un consecutivo nuevo)
    hacienda.state = "rechazado"
    await answered(notMine.body.id)
    hacienda.state = "aceptado"
    expect(await messageOf(notMine.body.id)).toMatchObject({ status: "REJECTED", message: "Mensaje rechazado por prueba" })
    const notes = await prisma.notification.findMany({ where: { type: "einvoiceProblem", userId: admin.user.id } })
    expect(notes).toEqual([expect.objectContaining({ link: `/payables/${notMine.body.supplierId}` })])
    const again = await request(app).post(`/payables/invoices/${notMine.body.id}/respond`).set(admin.auth).send({ decision: "PARTIAL", detail: "Faltó una caja" })
    expect(again.body).toMatchObject({ decision: "2", status: "SENT", consecutive: "00100001060000000001" })
  })

  it("una factura registrada a mano no tiene XML para responder; otra empresa no la ve", async () => {
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { idNumber: SUPPLIER_ID } })
    const manual = await request(app).post("/payables/invoices").set(admin.auth)
      .send({ supplierId: supplier.id, number: "A-100", issueDate: "2026-11-10", lines: [{ rate: "RATE_13", base: 1000 }] })
    expect((await request(app).post(`/payables/invoices/${manual.body.id}/respond`).set(admin.auth).send({ decision: "ACCEPT" })).body.error).toMatch(/registró a mano/)
    const any = await prisma.supplierInvoice.findFirstOrThrow({ where: { clave: { not: null } } })
    expect((await request(app).post(`/payables/invoices/${any.id}/respond`).set(other.auth).send({ decision: "ACCEPT" })).status).toBe(404)
  })
})

// Mensaje receptor (Bloque 9, punto 48 — parte 2): responderle a Hacienda sobre la factura electrónica de un
// proveedor ya importada (aceptar, aceptar parcialmente o rechazar). Respalda el crédito de IVA.
//  - Se arma una vez (consecutivo propio 05/06/07), se firma con la llave de la empresa y se guarda;
//    un reintento manda lo mismo. Sin respuesta de Hacienda se reintenta con espera, como los comprobantes.
//  - Si da crédito fiscal: condición 01 y se acredita todo el IVA; si no: 04 (gasto que no genera crédito).
//  - Si Hacienda rechaza el mensaje, avisa (campanita) y se puede responder de nuevo.
import { z } from "zod"
import { prisma, prismaRoot } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, runWithCompany } from "../../shared/tenant.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"
import { crDateTime } from "../einvoice/clave.ts"
import { RECEIVER_ID_TYPE_CODE } from "../einvoice/codes.ts"
import { einvoiceConfig } from "../einvoice/einvoice.config.ts"
import { haciendaStatus, sendToHacienda } from "../einvoice/hacienda.client.ts"
import { buildReceiverMessageXml, RECEIVER_TYPE, type Decision } from "../einvoice/receiver-xml.ts"
import { signXml } from "../einvoice/signer.ts"
import { RECEIVER_MESSAGE_XSD, validateWithSchema } from "../einvoice/xsd-validate.ts"
import { parseSupplierInvoice } from "./supplier-xml.ts"

const D = Prisma.Decimal
type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })
const MAX_ATTEMPTS = 10
const backoffMinutes = (attempts: number) => [1, 2, 5, 10, 30][attempts - 1] ?? 60
const DECISION: Record<"ACCEPT" | "PARTIAL" | "REJECT", Decision> = { ACCEPT: "1", PARTIAL: "2", REJECT: "3" }

export const respondSchema = z
  .object({
    decision: z.enum(["ACCEPT", "PARTIAL", "REJECT"]),
    detail: z.string().trim().max(160).optional(),
  })
  .refine((v) => v.decision === "ACCEPT" || (v.detail ?? "").length >= 3, { message: "Indica el motivo", path: ["detail"] })

type Row = Prisma.ReceiverMessageGetPayload<object>
const view = (m: Row) => ({
  decision: m.decision, detail: m.detail, condition: m.condition, taxCredit: m.taxCredit, consecutive: m.consecutive,
  environment: m.environment, status: m.status, message: m.message, attempts: m.attempts, lastError: m.lastError,
  sentAt: m.sentAt, answeredAt: m.answeredAt, nextAttemptAt: m.nextAttemptAt,
})

// Responder a Hacienda sobre una factura importada desde su XML
export async function respondInvoice(invoiceId: string, input: z.infer<typeof respondSchema>, userId: string) {
  const invoice = await prisma.supplierInvoice.findFirst({
    where: { id: invoiceId },
    select: { id: true, number: true, clave: true, xml: true, creditable: true, voidedAt: true, supplierId: true, receiverMessage: true },
  })
  if (!invoice) throw fail("Factura no encontrada", 404)
  if (!invoice.clave || !invoice.xml) throw fail("Esta factura se registró a mano: no tiene el XML para responder a Hacienda", 409, "RECEIVER_NO_XML")
  if (invoice.voidedAt) throw fail("La factura está anulada", 409, "RECEIVER_VOIDED")
  const prev = invoice.receiverMessage
  if (prev && !["REJECTED", "ERROR"].includes(prev.status)) throw fail("Ya se le respondió a Hacienda sobre esta factura", 409, "RECEIVER_DONE")

  const cfg = await einvoiceConfig() // sin configuración: 409 EINVOICE_NOT_CONFIGURED
  const company = await getCompany()
  if (!company.idNumber) throw fail("Completa la cédula de la empresa en Configuración → Datos fiscales", 409, "EINVOICE_FISCAL_DATA")
  const parsed = parseSupplierInvoice(invoice.xml)
  const decision = DECISION[input.decision]
  const tax = parsed.lines.reduce((s, l) => s.plus(l.tax), new D(0))
  const total = new D(parsed.total)
  const condition = decision === "3" ? null : invoice.creditable ? ("01" as const) : ("04" as const)
  const taxCredit = condition === "01" ? tax : new D(0)

  // consecutivo propio del mensaje (por tipo), con la empresa bloqueada para que dos respuestas no choquen
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Company" WHERE id = ${currentCompanyId()} FOR UPDATE`
    const type = RECEIVER_TYPE[decision]
    const last = await tx.receiverMessage.findFirst({
      where: { consecutive: { startsWith: `00100001${type}` } }, orderBy: { consecutive: "desc" }, select: { consecutive: true },
    })
    const consecutive = `00100001${type}${String(Number(last?.consecutive.slice(10) ?? 0) + 1).padStart(10, "0")}`
    const issuedAt = new Date()
    const xml = buildReceiverMessageXml({
      clave: invoice.clave!, supplierId: parsed.supplier.idNumber, issuedAt, decision, detail: input.detail ?? null,
      tax, activity: company.economicActivity, condition, taxCredit, expense: condition ? total.minus(taxCredit) : null,
      total, receiverId: company.idNumber!, consecutive,
    })
    const signed = await signXml(xml, cfg.key, issuedAt)
    const errors = await validateWithSchema(RECEIVER_MESSAGE_XSD, signed)
    if (errors.length) throw fail(`El mensaje no cumple el formato de Hacienda: ${errors[0]}`, 422, "RECEIVER_SCHEMA")
    const data = {
      decision, detail: input.detail ?? null, condition, taxCredit, consecutive, environment: cfg.credentials.env, xml: signed,
      status: "PENDING" as const, responseXml: null, message: null, attempts: 0, lastError: null, sentAt: null, answeredAt: null, nextAttemptAt: null,
      createdById: userId,
    }
    const row = prev
      ? await tx.receiverMessage.update({ where: { id: prev.id }, data })
      : await tx.receiverMessage.create({ data: { ...data, companyId: currentCompanyId(), invoiceId: invoice.id } })
    await logAudit(userId, "CREATE", "ReceiverMessage", row.id, { invoice: invoice.number, decision: input.decision, consecutive }, tx)
    return row
  })
  return sendMessage(saved.id)
}

const inFlight = new Set<string>()

// Envía el mensaje (o lo reintenta); si Hacienda lo recibió, se consulta la respuesta en unos segundos
async function sendMessage(messageId: string) {
  if (inFlight.has(messageId)) throw fail("Este mensaje ya se está enviando", 409, "RECEIVER_BUSY")
  inFlight.add(messageId)
  try {
    const m = await prisma.receiverMessage.findFirstOrThrow({ where: { id: messageId }, include: { invoice: { select: { clave: true, xml: true } } } })
    if (m.status !== "PENDING") return view(m)
    const cfg = await einvoiceConfig()
    if (cfg.credentials.env !== m.environment) {
      throw fail(`Este mensaje se firmó para el ambiente de ${m.environment} y el sistema está en ${cfg.credentials.env}`, 409, "EINVOICE_ENV")
    }
    const company = await getCompany()
    const supplier = parseSupplierInvoice(m.invoice.xml!).supplier
    let result: Awaited<ReturnType<typeof sendToHacienda>>
    try {
      result = await sendToHacienda(cfg.credentials, {
        clave: m.invoice.clave!, fecha: crDateTime(m.createdAt),
        emisor: { tipoIdentificacion: RECEIVER_ID_TYPE_CODE[supplier.idType ?? "JURIDICA"], numeroIdentificacion: supplier.idNumber },
        receptor: { tipoIdentificacion: RECEIVER_ID_TYPE_CODE[company.idType ?? "JURIDICA"], numeroIdentificacion: company.idNumber!.replace(/\D/g, "") },
        consecutivoReceptor: m.consecutive,
        comprobanteXml: Buffer.from(m.xml!, "utf8").toString("base64"),
      })
    } catch (err) {
      result = { received: false, status: 0, error: `Sin comunicación con Hacienda: ${(err as Error).message}` }
    }
    const attempts = m.attempts + 1
    const updated = await prisma.receiverMessage.update({
      where: { id: m.id },
      data: result.received
        ? { status: "SENT", sentAt: new Date(), attempts, lastError: null, nextAttemptAt: null }
        : { attempts, lastError: result.error.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMinutes(attempts) * 60_000) },
    })
    if (updated.status === "SENT") checkSoon(updated.id)
    return view(updated)
  } finally {
    inFlight.delete(messageId)
  }
}

// Consulta la respuesta de Hacienda (la clave del mensaje es la de la factura + su consecutivo)
async function refreshMessage(messageId: string) {
  const m = await prisma.receiverMessage.findFirstOrThrow({
    where: { id: messageId }, include: { invoice: { select: { clave: true, number: true, supplierId: true } } },
  })
  if (m.status !== "SENT") return view(m)
  const cfg = await einvoiceConfig()
  const st = await haciendaStatus(cfg.credentials, `${m.invoice.clave}-${m.consecutive}`)
  if (!st || !["aceptado", "rechazado"].includes(st.state)) return view(m)
  const updated = await prisma.receiverMessage.update({
    where: { id: m.id },
    data: { status: st.state === "aceptado" ? "ACCEPTED" : "REJECTED", responseXml: st.responseXml, message: st.message?.slice(0, 4000) ?? null, answeredAt: new Date() },
  })
  if (updated.status === "REJECTED") {
    const ids = await memberIdsWith("payables.manage")
    await createNotifications(ids.map((userId) => ({
      userId, type: "einvoiceProblem", title: m.invoice.number, link: `/payables/${m.invoice.supplierId}`,
      meta: { status: "REJECTED", message: `Respuesta a la factura del proveedor: ${(updated.message ?? "").slice(0, 260)}` },
    })))
  }
  return view(updated)
}

// Botón "Reintentar / Consultar" de la factura
export async function retryResponse(invoiceId: string) {
  const m = await prisma.receiverMessage.findFirst({ where: { invoiceId } })
  if (!m) throw fail("Todavía no se le respondió a Hacienda sobre esta factura", 404, "RECEIVER_NONE")
  return m.status === "PENDING" ? sendMessage(m.id) : refreshMessage(m.id)
}

const quiet = (where: string) => (err: unknown) => {
  const e = err as HttpError
  if (!["EINVOICE_NOT_CONFIGURED", "RECEIVER_BUSY"].includes(e.code ?? "")) console.error(`mensaje receptor (${where}):`, e.message)
}

// Hacienda suele responder en segundos: se consulta a los 8 y 25 s (en las pruebas no; el repaso se llama a mano)
function checkSoon(messageId: string) {
  if (process.env.NODE_ENV === "test") return
  const companyId = currentCompanyId()
  for (const ms of [8_000, 25_000]) {
    setTimeout(() => {
      runWithCompany(companyId, () => refreshMessage(messageId)).catch(quiet("consulta rápida"))
    }, ms).unref()
  }
}

let running = false
// Cada minuto (server.ts): reintentos que ya toca hacer y respuestas pendientes, de todas las empresas
export async function processReceiverMessages(limit = 50) {
  if (running) return { skipped: true }
  running = true
  const done = { sent: 0, refreshed: 0 }
  try {
    const now = new Date()
    const due = await prismaRoot.receiverMessage.findMany({
      where: {
        OR: [
          { status: "PENDING", attempts: { lt: MAX_ATTEMPTS }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { status: "SENT", sentAt: { lte: new Date(now.getTime() - 20_000) } },
        ],
      },
      select: { id: true, companyId: true, status: true }, take: limit,
    })
    for (const m of due) {
      await runWithCompany(m.companyId, () => (m.status === "PENDING" ? sendMessage(m.id) : refreshMessage(m.id)))
        .then(() => (m.status === "PENDING" ? done.sent++ : done.refreshed++), quiet("repaso"))
    }
    return done
  } finally {
    running = false
  }
}

// ¿Puede la empresa responder a Hacienda? (tiene la facturación electrónica configurada)
export async function receiverReady() {
  const s = await prisma.eInvoiceSettings.findFirst({ select: { passwordEnc: true, p12Enc: true, username: true } })
  return Boolean(s?.passwordEnc && s.p12Enc && s.username)
}

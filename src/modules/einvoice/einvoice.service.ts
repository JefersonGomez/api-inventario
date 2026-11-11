// Facturación electrónica (Bloque 9). Enviar un comprobante ya emitido a Hacienda y guardar su respuesta.
// Fase 1: a mano. Fase 2: cada empresa con su configuración cifrada y envío AUTOMÁTICO de los tiquetes
// (al vender y con un repaso cada minuto: envíos fallidos con espera creciente y consulta de respuestas).
//  - El XML se arma una vez (clave + firma) y se guarda: un reintento manda exactamente lo mismo.
//  - La llave debe ser de la misma identificación que la empresa (no se firma a nombre de otro).
//  - Si no se puede armar (falta el CABYS, datos fiscales…) queda en ERROR con el motivo: se corrige el dato
//    y se reintenta a mano. Un rechazo no se reenvía: se corrige con una nota de crédito (fase siguiente).
//  - ERROR y REJECTED avisan (campanita) a quien maneja la empresa.
import { prisma, prismaRoot } from "../../config/database.ts"
import type { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, runWithCompany } from "../../shared/tenant.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"
import { buildClave, crDateTime } from "./clave.ts"
import { ID_TYPE_CODE } from "./codes.ts"
import { einvoiceConfig } from "./einvoice.config.ts"
import { haciendaStatus, sendToHacienda } from "./hacienda.client.ts"
import { signXml } from "./signer.ts"
import { buildEInvoiceXml } from "./xml.ts"
import { emailDocument } from "./einvoice-email.ts"
import { validateEInvoiceXml } from "./xsd-validate.ts"

type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })
const sameId = (a: string, b: string) => a.replace(/\D/g, "").replace(/^0+/, "") === b.replace(/\D/g, "").replace(/^0+/, "")
// Errores del comprobante o de los datos (se guardan como ERROR); los demás (configuración, red) no
const DATA_ERRORS = new Set(["EINVOICE_FISCAL_DATA", "EINVOICE_KEY_MISMATCH", "EINVOICE_SCHEMA", "EINVOICE_DATA"])
export const AUTO_TYPES = ["TICKET", "INVOICE", "CREDIT_NOTE"] as const // la nota, cuando su venta original está aceptada
const MAX_ATTEMPTS = 10
// espera antes del siguiente reintento automático: 1, 2, 5, 10, 30 min y después cada hora
const backoffMinutes = (attempts: number) => [1, 2, 5, 10, 30][attempts - 1] ?? 60

type EInvoiceRow = Prisma.EInvoiceGetPayload<object>
const view = (e: EInvoiceRow) => ({
  documentId: e.documentId, clave: e.clave, environment: e.environment, status: e.status, message: e.message,
  attempts: e.attempts, lastError: e.lastError, sentAt: e.sentAt, answeredAt: e.answeredAt, nextAttemptAt: e.nextAttemptAt,
  emailedTo: e.emailedTo, emailedAt: e.emailedAt, emailError: e.emailError,
})
export type EInvoiceView = ReturnType<typeof view>

export async function getDocumentEInvoice(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { id: true, einvoice: true } })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  return doc.einvoice ? view(doc.einvoice) : null
}

// Datos fiscales que exige el XML del emisor; dice exactamente qué falta
export function assertFiscalData(c: Awaited<ReturnType<typeof getCompany>>) {
  const missing = [
    !(c.legalName ?? c.name)?.trim() && "razón social",
    (!c.idType || !c.idNumber || c.idType === "EXTRANJERO") && "identificación",
    !c.economicActivity && "actividad económica",
    (!c.province || !c.canton || !c.district) && "provincia, cantón y distrito",
    (c.addressDetail ?? "").trim().length < 5 && "otras señas",
    !c.invoiceEmail && "correo para comprobantes",
  ].filter(Boolean)
  if (missing.length) throw fail(`Faltan datos fiscales de la empresa: ${missing.join(", ")} (Configuración → Datos fiscales)`, 409, "EINVOICE_FISCAL_DATA")
}

// Aviso a quien maneja la empresa cuando un comprobante queda con error o rechazado
async function notifyProblem(e: EInvoiceRow, consecutive: string) {
  const ids = await memberIdsWith("company.manage")
  await createNotifications(ids.map((userId) => ({
    userId, type: "einvoiceProblem", title: consecutive, link: `/sales/${e.documentId}`,
    meta: { status: e.status, message: (e.message ?? e.lastError ?? "").slice(0, 300) },
  })))
}

// Arma, firma y guarda el comprobante (una sola vez). Si los datos no alcanzan, queda en ERROR.
async function prepare(documentId: string, actorId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId },
    include: {
      lines: { orderBy: { lineNumber: "asc" } }, payments: true, einvoice: true, customer: true,
      referenceDocument: { select: { type: true, issuedAt: true, total: true, einvoice: { select: { clave: true, status: true } } } },
    },
  })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  if (doc.einvoice && doc.einvoice.status !== "ERROR") return doc.einvoice
  if (!(AUTO_TYPES as readonly string[]).includes(doc.type)) {
    throw fail("Este tipo de comprobante todavía no se envía a Hacienda", 400, "EINVOICE_TYPE")
  }
  // la nota corrige un comprobante que Hacienda tiene aceptado; si no, no hay nada que corregir allá
  const original = doc.referenceDocument
  if (doc.type === "CREDIT_NOTE") {
    const st = original?.einvoice?.status
    if (!original?.einvoice?.clave || st !== "ACCEPTED") {
      throw fail(
        st === "PENDING" || st === "SENT"
          ? "La venta original todavía no está aceptada por Hacienda: la nota se envía sola cuando lo esté"
          : st === "REJECTED" || st === "ERROR"
            ? "La venta original no tiene validez en Hacienda (rechazada o con error): esta nota no se envía"
            : "La venta original no se envió a Hacienda: esta nota tampoco se envía",
        409, "EINVOICE_REFERENCE",
      )
    }
  }
  const cfg = await einvoiceConfig() // sin configuración no se registra nada: es un 409 para quien lo pidió
  try {
    const company = await getCompany()
    assertFiscalData(company)
    if (!sameId(company.idNumber!, cfg.key.holderId)) {
      throw fail("La llave criptográfica configurada es de otra identificación: no se puede firmar a nombre de esta empresa", 409, "EINVOICE_KEY_MISMATCH")
    }
    const clave = buildClave({ issuedAt: doc.issuedAt, idNumber: company.idNumber!, consecutive: doc.consecutive })
    let xml: string
    try {
      xml = buildEInvoiceXml({
        type: doc.type, clave, consecutive: doc.consecutive, issuedAt: doc.issuedAt,
        provider: cfg.provider, activity: company.economicActivity!.trim(),
        emitter: {
          name: (company.legalName ?? company.name).trim(), commercialName: company.name, idType: company.idType!, idNumber: company.idNumber!,
          province: company.province!, canton: company.canton!, district: company.district!, address: company.addressDetail!,
          phone: company.phone, email: company.invoiceEmail!,
        },
        // el cliente va en la factura y en la nota que corrige una factura (no en tiquetes)
        receiver: doc.customer?.idType && doc.customer.idNumber && (doc.type === "INVOICE" || original?.type === "INVOICE")
          ? { name: doc.customer.name, idType: doc.customer.idType, idNumber: doc.customer.idNumber, email: doc.customer.email }
          : null,
        reference: doc.type === "CREDIT_NOTE" && original
          ? {
              type: original.type, clave: original.einvoice!.clave!, issuedAt: original.issuedAt,
              code: doc.total.equals(original.total) ? "01" : "06", // devolvió todo = anula; si no, devolución de mercancía
              reason: doc.referenceReason ?? "Devolución",
            }
          : null,
        currency: doc.currency, saleCondition: doc.saleCondition, creditDays: doc.creditDays,
        lines: doc.lines.map((l) => ({
          cabys: l.cabys ?? "", quantity: l.quantity, unit: l.unit, description: l.description, unitPrice: l.unitPrice,
          discount: l.discount, discountLabel: l.discountLabel, taxRate: l.taxRate, subtotal: l.subtotal, taxAmount: l.taxAmount,
        })),
        payments: doc.payments.map((p) => ({ method: p.method, amount: p.amount })),
      })
    } catch (err) {
      throw fail((err as Error).message, 409, "EINVOICE_DATA") // p. ej. una línea sin CABYS
    }
    const signed = await signXml(xml, cfg.key)
    const errors = await validateEInvoiceXml(doc.type, signed)
    if (errors.length) throw fail(`El comprobante no cumple el formato de Hacienda: ${errors[0]}`, 422, "EINVOICE_SCHEMA")
    const data = { clave, environment: cfg.credentials.env, xml: signed, status: "PENDING" as const, lastError: null, attempts: 0, nextAttemptAt: null }
    const saved = doc.einvoice
      ? await prisma.eInvoice.update({ where: { id: doc.einvoice.id }, data })
      : await prisma.eInvoice.create({ data: { ...data, companyId: doc.companyId, documentId: doc.id } })
    await logAudit(actorId, "CREATE", "EInvoice", saved.id, { document: doc.consecutive, clave, environment: cfg.credentials.env })
    return saved
  } catch (err) {
    const e = err as HttpError
    if (!e.code || !DATA_ERRORS.has(e.code)) throw e
    // queda registrado para verlo en Ventas; se avisa una sola vez por motivo
    const data = { status: "ERROR" as const, environment: cfg.credentials.env, lastError: e.message.slice(0, 500), nextAttemptAt: null }
    const sameError = doc.einvoice?.lastError === data.lastError
    const row = doc.einvoice
      ? await prisma.eInvoice.update({ where: { id: doc.einvoice.id }, data })
      : await prisma.eInvoice.create({ data: { ...data, companyId: doc.companyId, documentId: doc.id } })
    if (!sameError) await notifyProblem(row, doc.consecutive)
    throw e
  }
}

// Un comprobante a la vez: el envío al vender y el repaso de cada minuto no deben tomar el mismo
const inFlight = new Set<string>()

// Envía el comprobante a Hacienda (o lo reintenta si el envío anterior falló)
export async function sendDocument(documentId: string, actorId: string) {
  if (inFlight.has(documentId)) throw fail("Este comprobante ya se está enviando", 409, "EINVOICE_BUSY")
  inFlight.add(documentId)
  try {
    return await sendNow(documentId, actorId)
  } finally {
    inFlight.delete(documentId)
  }
}

async function sendNow(documentId: string, actorId: string) {
  const e = await prepare(documentId, actorId)
  if (e.status !== "PENDING") return refreshDocument(documentId)
  const cfg = await einvoiceConfig()
  if (cfg.credentials.env !== e.environment) {
    throw fail(`Este comprobante se firmó para el ambiente de ${e.environment} y el sistema está en ${cfg.credentials.env}`, 409, "EINVOICE_ENV")
  }
  const [doc, company] = await Promise.all([
    prisma.document.findFirstOrThrow({ where: { id: documentId }, select: { issuedAt: true } }),
    getCompany(),
  ])
  let result: Awaited<ReturnType<typeof sendToHacienda>>
  try {
    result = await sendToHacienda(cfg.credentials, {
      clave: e.clave!, fecha: crDateTime(doc.issuedAt),
      emisor: { tipoIdentificacion: ID_TYPE_CODE[company.idType as keyof typeof ID_TYPE_CODE], numeroIdentificacion: company.idNumber! },
      comprobanteXml: Buffer.from(e.xml!, "utf8").toString("base64"),
    })
  } catch (err) {
    result = { received: false, status: 0, error: `Sin comunicación con Hacienda: ${(err as Error).message}` }
  }
  const attempts = e.attempts + 1
  const updated = await prisma.eInvoice.update({
    where: { id: e.id },
    data: result.received
      ? { status: "SENT", sentAt: new Date(), attempts, lastError: null, nextAttemptAt: null }
      : { attempts, lastError: result.error.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMinutes(attempts) * 60_000) },
  })
  return view(updated)
}

// Consulta la respuesta de Hacienda y la guarda
export async function refreshDocument(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { consecutive: true, einvoice: true } })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  const e = doc.einvoice
  if (!e) throw fail("Este comprobante todavía no se envió a Hacienda", 404, "EINVOICE_NOT_SENT")
  if (e.status !== "SENT") return view(e) // pendiente de envío, con error o ya con respuesta final
  const cfg = await einvoiceConfig()
  const st = await haciendaStatus(cfg.credentials, e.clave!)
  if (!st || !["aceptado", "rechazado"].includes(st.state)) return view(e)
  const updated = await prisma.eInvoice.update({
    where: { id: e.id },
    data: {
      status: st.state === "aceptado" ? "ACCEPTED" : "REJECTED",
      responseXml: st.responseXml, message: st.message?.slice(0, 4000) ?? null, answeredAt: new Date(),
    },
  })
  if (updated.status === "REJECTED") await notifyProblem(updated, doc.consecutive)
  // aceptado: se le entrega al cliente por correo (si falla, queda el motivo y se reenvía desde la venta)
  if (updated.status === "ACCEPTED") {
    const emailed = await emailDocument(documentId).catch((err: Error) => { console.error("facturación (correo):", err.message); return null })
    if (emailed) return view(emailed)
    return view(await prisma.eInvoice.findUniqueOrThrow({ where: { id: e.id } }))
  }
  return view(updated)
}

// Reenviar el comprobante aceptado al correo del cliente (botón en la venta)
export async function resendEmail(documentId: string, actorId: string) {
  const sent = await emailDocument(documentId, true)
  await logAudit(actorId, "UPDATE", "EInvoice", sent!.id, { emailedTo: sent!.emailedTo })
  return view(sent!)
}

// El XML firmado (para descargarlo o entregarlo al cliente)
export async function documentXml(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { einvoice: { select: { xml: true, clave: true } } } })
  if (!doc?.einvoice?.xml) throw fail("Este comprobante todavía no tiene XML firmado", 404)
  return { fileName: `${doc.einvoice.clave}.xml`, xml: doc.einvoice.xml }
}

// ---------- Envío automático ----------

const quiet = (where: string) => (err: unknown) => {
  const e = err as HttpError
  if (!e.code || !(DATA_ERRORS.has(e.code) || ["EINVOICE_NOT_CONFIGURED", "EINVOICE_BUSY", "EINVOICE_REFERENCE"].includes(e.code))) console.error(`facturación (${where}):`, e.message)
}

// Justo después de vender: si la empresa tiene el envío automático, se manda sin hacer esperar al cajero
export function queueEInvoice(documentId: string) {
  const companyId = currentCompanyId()
  setImmediate(() => {
    runWithCompany(companyId, () => autoSend(documentId)).catch(quiet("al vender"))
  })
}

async function autoSend(documentId: string) {
  const s = await prisma.eInvoiceSettings.findFirst({ select: { enabled: true, enabledAt: true } })
  if (!s?.enabled || !s.enabledAt) return
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { type: true, issuedAt: true, createdById: true } })
  if (!doc || !(AUTO_TYPES as readonly string[]).includes(doc.type) || doc.issuedAt < s.enabledAt) return
  await sendDocument(documentId, doc.createdById)
}

let running = false
// Cada minuto (server.ts), para todas las empresas con el envío automático encendido:
// tiquetes nuevos sin enviar, reintentos que ya toca hacer y respuestas pendientes de Hacienda.
export async function processEInvoices(limit = 50) {
  if (running) return { skipped: true }
  running = true
  const done = { sent: 0, refreshed: 0 }
  try {
    const companies = await prismaRoot.eInvoiceSettings.findMany({ where: { enabled: true, enabledAt: { not: null } }, select: { companyId: true, enabledAt: true } })
    for (const c of companies) {
      await runWithCompany(c.companyId, async () => {
        const now = new Date()
        const fresh = await prisma.document.findMany({
          where: {
            issuedAt: { gte: c.enabledAt! }, einvoice: null,
            // las notas, solo cuando Hacienda ya aceptó la venta que corrigen
            OR: [{ type: { in: ["TICKET", "INVOICE"] } }, { type: "CREDIT_NOTE", referenceDocument: { einvoice: { status: "ACCEPTED" } } }],
          },
          select: { id: true, createdById: true }, orderBy: { issuedAt: "asc" }, take: limit,
        })
        const retry = await prisma.eInvoice.findMany({
          where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          select: { documentId: true, document: { select: { createdById: true } } }, take: limit,
        })
        for (const d of [...fresh.map((f) => ({ id: f.id, by: f.createdById })), ...retry.map((r) => ({ id: r.documentId, by: r.document.createdById }))]) {
          await sendDocument(d.id, d.by).then(() => done.sent++, quiet("reintento"))
        }
        // respuestas: lo enviado hace más de 20 segundos
        const waiting = await prisma.eInvoice.findMany({
          where: { status: "SENT", sentAt: { lte: new Date(now.getTime() - 20_000) } }, select: { documentId: true }, take: limit,
        })
        for (const w of waiting) await refreshDocument(w.documentId).then(() => done.refreshed++, quiet("consulta"))
      })
    }
    return done
  } finally {
    running = false
  }
}

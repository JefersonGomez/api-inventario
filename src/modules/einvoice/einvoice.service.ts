// Facturación electrónica (Bloque 9, fase 1): enviar un comprobante ya emitido a Hacienda y consultar
// su respuesta. Fase 1 = solo tiquetes y a mano (botón); la emisión automática desde la caja, facturas,
// notas y la cola con reintentos llegan en las siguientes fases.
//  - El XML se arma una vez (clave + firma) y se guarda: un reintento manda exactamente lo mismo.
//  - La llave debe ser de la misma identificación que la empresa (no se firma a nombre de otro).
//  - Un rechazo no se "reenvía": se corrige con una nota de crédito (fase siguiente).
import { prisma } from "../../config/database.ts"
import type { Prisma } from "../../generated/prisma/client.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { buildClave, crDateTime } from "./clave.ts"
import { ID_TYPE_CODE } from "./codes.ts"
import { einvoiceConfig } from "./einvoice.config.ts"
import { haciendaStatus, sendToHacienda } from "./hacienda.client.ts"
import { signXml } from "./signer.ts"
import { buildEInvoiceXml } from "./xml.ts"
import { validateEInvoiceXml } from "./xsd-validate.ts"

const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
const sameId = (a: string, b: string) => a.replace(/\D/g, "").replace(/^0+/, "") === b.replace(/\D/g, "").replace(/^0+/, "")

const view = (e: Prisma.EInvoiceGetPayload<object>) => ({
  documentId: e.documentId, clave: e.clave, environment: e.environment, status: e.status, message: e.message,
  attempts: e.attempts, lastError: e.lastError, sentAt: e.sentAt, answeredAt: e.answeredAt,
})

export async function getDocumentEInvoice(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { id: true, einvoice: true } })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  return doc.einvoice ? view(doc.einvoice) : null
}

// Datos fiscales que exige el XML del emisor; dice exactamente qué falta
function assertFiscalData(c: Awaited<ReturnType<typeof getCompany>>) {
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

// Arma, firma y guarda el comprobante (una sola vez)
async function prepare(documentId: string, actorId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, payments: true, einvoice: true },
  })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  if (doc.einvoice) return doc.einvoice
  if (doc.type !== "TICKET") throw fail("Por ahora solo se envían tiquetes a Hacienda (facturas y notas llegan en la siguiente fase)", 400, "EINVOICE_TYPE")

  const cfg = await einvoiceConfig()
  const company = await getCompany()
  assertFiscalData(company)
  if (!sameId(company.idNumber!, cfg.key.holderId)) {
    throw fail("La llave criptográfica configurada es de otra identificación: no se puede firmar a nombre de esta empresa", 409, "EINVOICE_KEY_MISMATCH")
  }
  const clave = buildClave({ issuedAt: doc.issuedAt, idNumber: company.idNumber!, consecutive: doc.consecutive })
  const xml = buildEInvoiceXml({
    type: doc.type, clave, consecutive: doc.consecutive, issuedAt: doc.issuedAt,
    provider: cfg.provider, activity: company.economicActivity!.trim(),
    emitter: {
      name: (company.legalName ?? company.name).trim(), commercialName: company.name, idType: company.idType!, idNumber: company.idNumber!,
      province: company.province!, canton: company.canton!, district: company.district!, address: company.addressDetail!,
      phone: company.phone, email: company.invoiceEmail!,
    },
    currency: doc.currency, saleCondition: doc.saleCondition, creditDays: doc.creditDays,
    lines: doc.lines.map((l) => ({
      cabys: l.cabys ?? "", quantity: l.quantity, unit: l.unit, description: l.description, unitPrice: l.unitPrice,
      discount: l.discount, discountLabel: l.discountLabel, taxRate: l.taxRate, subtotal: l.subtotal, taxAmount: l.taxAmount,
    })),
    payments: doc.payments.map((p) => ({ method: p.method, amount: p.amount })),
  })
  const signed = await signXml(xml, cfg.key)
  const errors = await validateEInvoiceXml(doc.type, signed)
  if (errors.length) throw fail(`El comprobante no cumple el formato de Hacienda: ${errors[0]}`, 422, "EINVOICE_SCHEMA")
  const created = await prisma.eInvoice.create({
    data: { companyId: doc.companyId, documentId: doc.id, clave, environment: cfg.credentials.env, xml: signed },
  })
  await logAudit(actorId, "CREATE", "EInvoice", created.id, { document: doc.consecutive, clave, environment: cfg.credentials.env })
  return created
}

// Envía el comprobante a Hacienda (o lo reintenta si el envío anterior falló)
export async function sendDocument(documentId: string, actorId: string) {
  const e = await prepare(documentId, actorId)
  if (e.status !== "PENDING") return refreshDocument(documentId)
  const cfg = await einvoiceConfig()
  if (cfg.credentials.env !== e.environment) {
    throw fail(`Este comprobante se firmó para el ambiente de ${e.environment} y el sistema está en ${cfg.credentials.env}`, 409, "EINVOICE_ENV")
  }
  const doc = await prisma.document.findFirstOrThrow({ where: { id: documentId }, select: { issuedAt: true } })
  const company = await getCompany()
  let result: Awaited<ReturnType<typeof sendToHacienda>>
  try {
    result = await sendToHacienda(cfg.credentials, {
      clave: e.clave, fecha: crDateTime(doc.issuedAt),
      emisor: { tipoIdentificacion: ID_TYPE_CODE[company.idType as keyof typeof ID_TYPE_CODE], numeroIdentificacion: company.idNumber! },
      comprobanteXml: Buffer.from(e.xml, "utf8").toString("base64"),
    })
  } catch (err) {
    result = { received: false, status: 0, error: `Sin comunicación con Hacienda: ${(err as Error).message}` }
  }
  const updated = await prisma.eInvoice.update({
    where: { id: e.id },
    data: result.received
      ? { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null }
      : { attempts: { increment: 1 }, lastError: result.error.slice(0, 500) },
  })
  return view(updated)
}

// Consulta la respuesta de Hacienda y la guarda
export async function refreshDocument(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { einvoice: true } })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  const e = doc.einvoice
  if (!e) throw fail("Este comprobante todavía no se envió a Hacienda", 404, "EINVOICE_NOT_SENT")
  if (e.status !== "SENT") return view(e) // pendiente de envío o ya con respuesta final
  const cfg = await einvoiceConfig()
  const st = await haciendaStatus(cfg.credentials, e.clave)
  if (!st || !["aceptado", "rechazado"].includes(st.state)) return view(e)
  const updated = await prisma.eInvoice.update({
    where: { id: e.id },
    data: {
      status: st.state === "aceptado" ? "ACCEPTED" : "REJECTED",
      responseXml: st.responseXml, message: st.message?.slice(0, 4000) ?? null, answeredAt: new Date(),
    },
  })
  return view(updated)
}

// El XML firmado (para descargarlo o entregarlo al cliente)
export async function documentXml(documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId }, select: { consecutive: true, einvoice: { select: { xml: true, clave: true } } } })
  if (!doc?.einvoice) throw fail("Este comprobante todavía no tiene XML firmado", 404)
  return { fileName: `${doc.einvoice.clave}.xml`, xml: doc.einvoice.xml }
}

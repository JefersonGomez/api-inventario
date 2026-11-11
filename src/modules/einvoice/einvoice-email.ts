// Entrega del comprobante al cliente (Bloque 9, fase 3): cuando Hacienda lo acepta, al correo del cliente
// le llega el resumen de la compra con el XML firmado y la respuesta de Hacienda adjuntos.
// Si no se puede (cliente sin correo, correo del servidor sin configurar) queda anotado el motivo y se
// puede reintentar desde la venta. Nunca hace fallar el envío a Hacienda.
import { prisma } from "../../config/database.ts"
import { escapeHtml, sendEmail } from "../../shared/email.ts"
import { formatMoney } from "../../shared/money.ts"
import { getCompany } from "../company/company.service.ts"

type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })

const TYPE_LABEL = { TICKET: "Tiquete electrónico", INVOICE: "Factura electrónica", CREDIT_NOTE: "Nota de crédito electrónica", DEBIT_NOTE: "Nota de débito electrónica" } as const
const validEmail = (s: string | null | undefined) => !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim())

// Envía el comprobante aceptado al correo del cliente. manual = lo pidió alguien (errores como 409).
export async function emailDocument(documentId: string, manual = false) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, customer: true, einvoice: true },
  })
  if (!doc) throw fail("Comprobante no encontrado", 404)
  const e = doc.einvoice
  if (!e || e.status !== "ACCEPTED" || !e.xml) {
    throw fail("Se le envía al cliente cuando Hacienda acepta el comprobante", 409, "EINVOICE_NOT_ACCEPTED")
  }
  const to = doc.customer?.email?.trim()
  const note = async (emailError: string) => {
    await prisma.eInvoice.update({ where: { id: e.id }, data: { emailError } })
    if (manual) throw fail(emailError, 409, "EINVOICE_EMAIL")
    return null
  }
  if (!validEmail(to)) return note(doc.customer ? "El cliente no tiene un correo válido: agrégalo en Clientes y reenvía" : "La venta no tiene cliente con correo")

  const company = await getCompany()
  const money = (v: unknown) => formatMoney(Number(v), doc.currency)
  const title = TYPE_LABEL[doc.type]
  const issuer = escapeHtml((company.legalName ?? company.name).trim())
  const rows = doc.lines.map((l) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.description)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${Number(l.quantity)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${money(l.total)}</td>
    </tr>`).join("")
  const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">
  <h2 style="margin:0 0 4px">${title}</h2>
  <p style="margin:0 0 16px;color:#555">${issuer}${company.idNumber ? ` · Cédula ${escapeHtml(company.idNumber)}` : ""}</p>
  <p style="margin:0">Hola ${escapeHtml(doc.customer!.name)}, gracias por tu compra. Este es tu comprobante, aceptado por el Ministerio de Hacienda.</p>
  <p style="margin:12px 0 4px"><b>Número:</b> ${doc.consecutive}<br><b>Fecha:</b> ${doc.issuedAt.toLocaleString("es-CR", { timeZone: "America/Costa_Rica" })}<br><b>Clave:</b> <span style="font-family:monospace;font-size:12px">${e.clave}</span></p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:12px">
    <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Detalle</th><th style="padding:6px 8px;text-align:right">Cant.</th><th style="padding:6px 8px;text-align:right">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="text-align:right;margin:12px 0 0">Subtotal: ${money(doc.subtotal)}<br>IVA: ${money(doc.taxTotal)}<br><b style="font-size:16px">Total: ${money(doc.total)}</b></p>
  <p style="margin-top:20px;font-size:12px;color:#777">Adjuntos: el comprobante electrónico (XML firmado) y la respuesta de Hacienda. Guárdalos para tu contabilidad.</p>
</div>`
  const attachments = [
    { filename: `${e.clave}.xml`, content: Buffer.from(e.xml, "utf8").toString("base64") },
    ...(e.responseXml ? [{ filename: `${e.clave}-respuesta-hacienda.xml`, content: Buffer.from(e.responseXml, "utf8").toString("base64") }] : []),
  ]
  try {
    await sendEmail({ to: to!, subject: `${title} ${doc.consecutive} · ${issuer}`, html, attachments })
  } catch (err) {
    return note(`No se pudo enviar el correo: ${(err as Error).message}`.slice(0, 500))
  }
  return prisma.eInvoice.update({ where: { id: e.id }, data: { emailedTo: to!, emailedAt: new Date(), emailError: null } })
}

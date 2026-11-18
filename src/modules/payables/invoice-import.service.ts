// Importar la factura electrónica de un proveedor desde su XML (Bloque 9, punto 48 — parte 1):
//  1. vista previa: se lee el XML (y la respuesta de Hacienda, si viene), se revisa y se muestra qué se va a
//     registrar, con avisos (otro receptor, firma, totales) y bloqueos (ya importada, rechazada por Hacienda…);
//  2. al confirmar se vuelve a leer en el servidor (no se confía en lo que manda la pantalla), se crea el
//     proveedor si no existe y la factura queda en Cuentas por pagar con su clave y el XML.
//  3. opcional (respond=true): se acepta ante Hacienda en el mismo paso (mensaje receptor, parte 2).
// La entrada al inventario es la parte 3.
import { z } from "zod"
import { prisma, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { crDateTime } from "../einvoice/clave.ts"
import { verifyXml } from "../einvoice/signer.ts"
import { createInvoice } from "./payables.service.ts"
import { parseHaciendaAnswer, parseSupplierInvoice, rootName, type ParsedSupplierInvoice } from "./supplier-xml.ts"
import { receiverReady, respondInvoice } from "./receiver-message.service.ts"

const D = Prisma.Decimal
const DAY = 86_400_000
type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })
const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/\D/g, "").replace(/^0+/, "") === b.replace(/\D/g, "").replace(/^0+/, "")

export const importXmlSchema = z.object({
  dueDate: z.iso.date().optional(),
  creditable: z.enum(["true", "false"]).optional(), // multipart: llega como texto
  note: z.string().trim().max(200).optional(),
  respond: z.enum(["true", "false"]).optional(), // aceptarla ante Hacienda al registrar
})

type Notice = { level: "error" | "warning" | "info"; code: string; text: string }

// Separa los archivos subidos: la factura y, opcional, la respuesta de Hacienda
function sortFiles(files: Buffer[]) {
  if (!files.length) throw fail("Sube el XML de la factura del proveedor", 400, "XML_MISSING")
  const texts = files.map((f) => f.toString("utf8").replace(/^﻿/, ""))
  const invoices = texts.filter((t) => rootName(t) !== "MensajeHacienda")
  const answers = texts.filter((t) => rootName(t) === "MensajeHacienda")
  if (invoices.length !== 1) throw fail(invoices.length ? "Sube una sola factura a la vez" : "Falta el XML de la factura (solo subiste la respuesta de Hacienda)", 400, "XML_MISSING")
  return { invoiceXml: invoices[0]!, answerXml: answers[0] ?? null }
}

async function analyze(files: Buffer[]) {
  const { invoiceXml, answerXml } = sortFiles(files)
  let parsed: ParsedSupplierInvoice
  try {
    parsed = parseSupplierInvoice(invoiceXml)
  } catch (err) {
    throw fail((err as Error).message, 422, "XML_INVALID")
  }
  const notices: Notice[] = []
  const company = await getCompany()

  // respuesta de Hacienda: tiene que ser de esta misma factura
  let answer = answerXml ? parseHaciendaAnswer(answerXml) : null
  if (answer && answer.clave !== parsed.clave) {
    notices.push({ level: "warning", code: "ANSWER_OTHER", text: "La respuesta de Hacienda que subiste es de otra factura: no se tomó en cuenta" })
    answer = null
  }
  if (answer?.status === "Rechazado") notices.push({ level: "error", code: "REJECTED", text: "Hacienda RECHAZÓ esta factura: no tiene validez. Pídele al proveedor que la emita de nuevo" })
  else if (!answer) notices.push({ level: "info", code: "NO_ANSWER", text: "No viene la respuesta de Hacienda: no se puede confirmar que la haya aceptado (suele llegar en el mismo correo del proveedor)" })

  // a nombre de quién está: sin la cédula de la empresa no da crédito fiscal
  const receiverMatches = parsed.kind !== "TICKET" && sameId(parsed.receiverId, company.idNumber)
  if (parsed.kind === "TICKET") notices.push({ level: "warning", code: "TICKET", text: "Es un tiquete, no una factura a nombre de la empresa: se registra para pagarlo, pero no da crédito fiscal" })
  else if (!company.idNumber) notices.push({ level: "warning", code: "NO_COMPANY_ID", text: "La empresa no tiene su cédula en Datos fiscales: no se puede revisar a nombre de quién está la factura" })
  else if (!receiverMatches) notices.push({ level: "warning", code: "OTHER_RECEIVER", text: `La factura está a nombre de otra identificación (${parsed.receiverId ?? "sin receptor"}): no da crédito fiscal a la empresa` })

  if (!(await verifyXml(invoiceXml).catch(() => false))) {
    notices.push({ level: "warning", code: "SIGNATURE", text: "No se pudo verificar la firma digital del XML: revisa que sea el archivo original que mandó el proveedor" })
  }
  if (parsed.unsupportedRates.length) {
    notices.push({ level: "error", code: "RATE", text: `Trae una tarifa de IVA que el sistema todavía no maneja (${parsed.unsupportedRates.join(", ")}): regístrala a mano` })
  }

  // moneda: los montos quedan en la moneda de la empresa
  let factor = new D(1)
  if (parsed.currency !== company.currency) {
    if (parsed.currency === "USD" && company.currency === "CRC" && parsed.exchangeRate > 1) {
      factor = new D(parsed.exchangeRate)
      notices.push({ level: "info", code: "CURRENCY", text: `La factura está en dólares: se registra en colones con el tipo de cambio que trae (₡${parsed.exchangeRate})` })
    } else {
      notices.push({ level: "error", code: "CURRENCY", text: `La factura está en ${parsed.currency} y la empresa lleva sus cuentas en ${company.currency}: regístrala a mano` })
    }
  }
  const taxes = parsed.taxes.map((t) => ({ rate: t.rate, base: new D(t.base).times(factor).toDecimalPlaces(2).toNumber(), tax: new D(t.tax).times(factor).toDecimalPlaces(2).toNumber() }))
  const computed = taxes.reduce((s, t) => s.plus(t.base).plus(t.tax), new D(0))
  const declared = new D(parsed.total).times(factor).toDecimalPlaces(2)
  if (computed.minus(declared).abs().greaterThan(1)) {
    notices.push({ level: "warning", code: "TOTAL", text: `El total que suman las líneas (${computed.toFixed(2)}) no coincide con el total de la factura (${declared.toFixed(2)}); se registra lo que suman las líneas` })
  }
  if (parsed.otherCharges > 0) notices.push({ level: "info", code: "OTHER_CHARGES", text: "Trae otros cargos (por ejemplo servicio o flete): se suman como monto sin IVA" })

  // proveedor: por su cédula (si no existe, se crea al registrar)
  const supplier = await prisma.supplier.findFirst({ where: { idNumber: parsed.supplier.idNumber }, select: { id: true, name: true, creditDays: true } })
  const duplicate = await prisma.supplierInvoice.findFirst({
    where: { OR: [{ clave: parsed.clave }, ...(supplier ? [{ supplierId: supplier.id, number: parsed.number, voidedAt: null }] : [])] },
    select: { id: true, supplierId: true, voidedAt: true },
  })
  if (duplicate && !duplicate.voidedAt) notices.push({ level: "error", code: "DUPLICATE", text: "Esta factura ya está registrada en Cuentas por pagar" })

  // fechas en hora de Costa Rica; vence según el plazo de la factura o, si no trae, el del proveedor
  const issueDate = crDateTime(parsed.issuedAt).slice(0, 10)
  const isNote = parsed.kind === "CREDIT_NOTE"
  const days = isNote ? 0 : parsed.saleCondition === "02" && parsed.creditDays ? parsed.creditDays : (supplier?.creditDays ?? 0)
  const dueDate = new Date(new Date(`${issueDate}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10)

  // nota de crédito: rebaja lo que se le debe al proveedor, empezando por la factura que corrige
  let credit: Awaited<ReturnType<typeof creditPlan>> | null = null
  if (isNote) {
    const refClave = parsed.reference?.clave ?? null
    const original = refClave
      ? await prisma.supplierInvoice.findFirst({ where: { clave: refClave, type: "INVOICE", voidedAt: null }, select: { id: true, number: true, supplierId: true } })
      : null
    if (original && supplier && original.supplierId !== supplier.id) {
      notices.push({ level: "error", code: "ORIGINAL_OTHER", text: "La factura que corrige esta nota es de otro proveedor: revisa el archivo" })
    } else if (!original) {
      notices.push({ level: "warning", code: "NO_ORIGINAL", text: `No está registrada la factura que corrige${refClave ? ` (…${refClave.slice(-20)})` : ""}: se rebaja de las facturas abiertas de este proveedor` })
    }
    credit = await creditPlan(prisma, supplier?.id ?? null, original?.id ?? null, computed.toDecimalPlaces(2))
    if (credit.unapplied > 0) {
      notices.push({ level: "info", code: "UNAPPLIED", text: `Quedan ${credit.unapplied.toFixed(2)} a favor: no hay facturas abiertas de este proveedor para rebajarlos (el proveedor te los debe)` })
    }
  }

  return {
    parsed, invoiceXml, answer,
    preview: {
      kind: parsed.kind,
      clave: parsed.clave,
      number: parsed.number,
      issueDate,
      dueDate,
      creditDays: days,
      supplier: { ...parsed.supplier, existing: supplier ? { id: supplier.id, name: supplier.name } : null },
      currency: parsed.currency,
      exchangeRate: parsed.exchangeRate,
      lines: parsed.lines,
      taxes,
      total: computed.toDecimalPlaces(2).toNumber(),
      haciendaStatus: answer?.status ?? null,
      creditable: receiverMatches && answer?.status !== "Rechazado",
      duplicateId: duplicate && !duplicate.voidedAt ? duplicate.id : null,
      notices,
      canImport: !notices.some((n) => n.level === "error"),
      receiverReady: parsed.kind !== "TICKET" && (await receiverReady()), // se puede aceptar ante Hacienda desde aquí
      // nota de crédito: a qué facturas se rebaja y cuánto queda a favor
      credit: credit && { original: credit.original, applied: credit.applied.map((a) => ({ id: a.id, number: a.number, amount: a.amount.toNumber() })), unapplied: credit.unapplied },
    },
  }
}

// A qué facturas abiertas del proveedor se rebaja una nota de crédito: la que corrige primero y luego la que
// vence primero. Lo que no alcanza a rebajarse queda "a favor".
async function creditPlan(db: Db, supplierId: string | null, originalId: string | null, amount: Prisma.Decimal) {
  const open = supplierId
    ? await db.supplierInvoice.findMany({
        where: { supplierId, type: "INVOICE", voidedAt: null, paid: { lt: prisma.supplierInvoice.fields.total } },
        select: { id: true, number: true, total: true, paid: true },
        orderBy: [{ dueDate: "asc" }, { number: "asc" }],
      })
    : []
  const ordered = [...open.filter((i) => i.id === originalId), ...open.filter((i) => i.id !== originalId)]
  let left = amount
  const applied: { id: string; number: string; amount: Prisma.Decimal }[] = []
  for (const inv of ordered) {
    if (!left.greaterThan(0)) break
    const take = D.min(left, inv.total.minus(inv.paid))
    if (take.greaterThan(0)) applied.push({ id: inv.id, number: inv.number, amount: take })
    left = left.minus(take)
  }
  const original = originalId ? (await db.supplierInvoice.findFirst({ where: { id: originalId }, select: { id: true, number: true } })) : null
  return { original, applied, unapplied: left.toDecimalPlaces(2).toNumber() }
}

// Vista previa: qué se va a registrar y qué hay que revisar
export async function previewXmlInvoice(files: Buffer[]) {
  return (await analyze(files)).preview
}

// Registrar la factura importada en Cuentas por pagar
export async function importXmlInvoice(files: Buffer[], input: z.infer<typeof importXmlSchema>, userId: string) {
  const { parsed, invoiceXml, answer, preview } = await analyze(files)
  const blocking = preview.notices.find((n) => n.level === "error")
  if (blocking) throw fail(blocking.text, 409, `XML_${blocking.code}`)
  const saved = await prisma.$transaction(async (tx) => {
    let supplierId = preview.supplier.existing?.id
    if (!supplierId) {
      // nombre único por empresa: si ya hay otro proveedor con ese nombre, se distingue con la cédula
      const taken = await tx.supplier.findFirst({ where: { name: parsed.supplier.name }, select: { id: true } })
      const name = taken ? `${parsed.supplier.name} (${parsed.supplier.idNumber})` : parsed.supplier.name
      const created = await tx.supplier.create({
        data: {
          companyId: (await getCompany()).id, name,
          ...(parsed.supplier.idType && { idType: parsed.supplier.idType, idNumber: parsed.supplier.idNumber }),
          ...(parsed.supplier.email && { email: parsed.supplier.email }),
          ...(parsed.supplier.phone && { phone: parsed.supplier.phone }),
          ...(parsed.saleCondition === "02" && parsed.creditDays && { creditDays: parsed.creditDays }),
        },
      })
      await logAudit(userId, "CREATE", "Supplier", created.id, { name, idNumber: parsed.supplier.idNumber, source: "xml" }, tx)
      supplierId = created.id
    }
    const invoice = await createInvoice(tx, {
      supplierId, number: parsed.number, issueDate: preview.issueDate, dueDate: input.dueDate ?? preview.dueDate,
      lines: preview.taxes, creditable: input.creditable ? input.creditable === "true" : preview.creditable,
      ...(input.note && { note: input.note }),
    }, userId)
    const isNote = parsed.kind === "CREDIT_NOTE"
    const saved = await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: {
        clave: parsed.clave, xml: invoiceXml, haciendaStatus: answer?.status ?? null,
        // la nota no es deuda: queda "usada" (paid = total) y su efecto es el abono de abajo
        ...(isNote && { type: "CREDIT_NOTE" as const, paid: invoice.total, referenceInvoiceId: preview.credit?.original?.id ?? null }),
      },
      select: { id: true, type: true, supplierId: true, number: true, issueDate: true, dueDate: true, total: true, creditable: true, clave: true, haciendaStatus: true },
    })
    if (isNote) {
      // con el proveedor bloqueado: lo abierto se recalcula aquí (no se confía en la vista previa)
      await tx.$queryRaw`SELECT 1 FROM "Supplier" WHERE id = ${supplierId} FOR UPDATE`
      const plan = await creditPlan(tx, supplierId, preview.credit?.original?.id ?? null, invoice.total)
      const applied = plan.applied.reduce((s, a) => s.plus(a.amount), new D(0))
      if (applied.greaterThan(0)) {
        await tx.supplierPayment.create({
          data: {
            companyId: invoice.companyId, supplierId, amount: applied, method: "OTHER", paidAt: invoice.issueDate,
            reference: `NC ${parsed.number.slice(-10)}`, note: parsed.reference?.reason?.slice(0, 200) ?? "Nota de crédito del proveedor",
            userId, creditNoteId: saved.id,
            allocations: { create: plan.applied.map((a) => ({ invoiceId: a.id, amount: a.amount })) },
          },
        })
        for (const a of plan.applied) await tx.supplierInvoice.update({ where: { id: a.id }, data: { paid: { increment: a.amount } } })
      }
      await logAudit(userId, "CREATE", "SupplierCreditNote", saved.id, {
        number: parsed.number, total: invoice.total.toNumber(), applied: applied.toNumber(), unapplied: plan.unapplied,
        original: preview.credit?.original?.number ?? null,
      }, tx)
    }
    return saved
  })
  if (input.respond !== "true" || parsed.kind === "TICKET") return saved
  // la factura ya quedó registrada: si la respuesta a Hacienda falla, se dice por qué y se responde después
  try {
    return { ...saved, receiverMessage: await respondInvoice(saved.id, { decision: "ACCEPT" }, userId) }
  } catch (err) {
    return { ...saved, respondError: (err as Error).message }
  }
}

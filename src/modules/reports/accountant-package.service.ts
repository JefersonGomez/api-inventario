// Paquete para el contador (reemplaza al Bloque 11, decisión del usuario del 25-oct-2026): todo lo del mes
// en un solo Excel, que arma el frontend con este JSON. Mismo permiso que el IVA del mes (accounting.view).
// Parte A: IVA del mes, ventas por comprobante, compras (las facturas del IVA) y movimientos de bancos.
// Parte B (pendiente): cuentas por cobrar, por pagar e inventario valorizado al cierre del mes.
// ponytail: lee los comprobantes del mes de una vez (miles en una pyme); paginar si crece.
import { prisma } from "../../config/database.ts"
import { Prisma, type TaxRate } from "../../generated/prisma/client.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { getVatReport, monthRange, type vatReportQuerySchema } from "./vat-report.service.ts"
import type { z } from "zod"

const D = Prisma.Decimal
const num = (v: Prisma.Decimal | number | null | undefined) => Number(new D(v ?? 0).toDecimalPlaces(2))

export async function getAccountantPackage(q: z.infer<typeof vatReportQuerySchema>) {
  const range = monthRange(q.month)
  const [company, vat, docs, accounts] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: currentCompanyId() },
      select: { name: true, legalName: true, idType: true, idNumber: true, currency: true },
    }),
    getVatReport(q),
    prisma.document.findMany({
      where: { issuedAt: range.local },
      select: {
        id: true, type: true, consecutive: true, issuedAt: true, saleCondition: true,
        subtotal: true, discountTotal: true, taxTotal: true, total: true, referenceReason: true,
        customer: { select: { name: true, idNumber: true } },
        referenceDocument: { select: { consecutive: true } },
        lines: { select: { taxRate: true, subtotal: true, taxAmount: true } },
        payments: { select: { method: true, amount: true } },
      },
      orderBy: [{ issuedAt: "asc" }, { number: "asc" }],
    }),
    prisma.bankAccount.findMany({
      select: {
        id: true, name: true, bankName: true, number: true, currency: true,
        transactions: {
          where: { date: range.utc },
          select: {
            date: true, reference: true, description: true, amount: true, category: true, note: true, fee: true,
            matches: { select: { label: true } },
          },
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: { name: "asc" },
    }),
  ])

  // ventas: un renglón por comprobante; las notas de crédito restan (montos en negativo)
  const documents = docs.map((d) => {
    const sign = d.type === "CREDIT_NOTE" ? -1 : 1
    const byRate: Partial<Record<TaxRate, { base: number; tax: number }>> = {}
    for (const l of d.lines) {
      const r = (byRate[l.taxRate] ??= { base: 0, tax: 0 })
      r.base += sign * Number(l.subtotal)
      r.tax += sign * Number(l.taxAmount)
    }
    for (const r of Object.values(byRate)) {
      r.base = num(r.base)
      r.tax = num(r.tax)
    }
    const paid = new Map<string, number>()
    for (const p of d.payments) paid.set(p.method, (paid.get(p.method) ?? 0) + sign * Number(p.amount))
    return {
      id: d.id, type: d.type, consecutive: d.consecutive, issuedAt: d.issuedAt, saleCondition: d.saleCondition,
      customer: d.customer, reference: d.referenceDocument?.consecutive ?? null, referenceReason: d.referenceReason,
      subtotal: num(sign * Number(d.subtotal)), discount: num(sign * Number(d.discountTotal)),
      tax: num(sign * Number(d.taxTotal)), total: num(sign * Number(d.total)),
      byRate, payments: Object.fromEntries([...paid].map(([m, v]) => [m, num(v)])),
    }
  })
  const sum = (k: "subtotal" | "tax" | "total") => num(documents.reduce((s, d) => s + d[k], 0))

  // bancos: cada movimiento del mes con su estado (conciliado con qué, clasificado o pendiente)
  const banks = accounts
    .filter((a) => a.transactions.length > 0)
    .map((a) => ({
      account: { id: a.id, name: a.name, bankName: a.bankName, number: a.number, currency: a.currency },
      transactions: a.transactions.map((t) => ({
        date: t.date.toISOString().slice(0, 10), reference: t.reference, description: t.description, amount: num(t.amount),
        status: t.matches.length ? "MATCHED" : t.category ? "CLASSIFIED" : "PENDING",
        matchedWith: t.matches.map((m) => m.label), category: t.category, note: t.note, fee: t.fee == null ? null : num(t.fee),
      })),
      totals: {
        credits: num(a.transactions.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0)),
        debits: num(a.transactions.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Number(t.amount), 0)),
        pending: a.transactions.filter((t) => !t.matches.length && !t.category).length,
      },
    }))

  return {
    month: q.month,
    company,
    vat,
    sales: { documents, totals: { count: documents.length, subtotal: sum("subtotal"), tax: sum("tax"), total: sum("total") } },
    banks,
  }
}

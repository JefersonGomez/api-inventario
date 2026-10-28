// IVA del mes (punto 54B, versión SIMPLE decidida por el usuario el 25-oct-2026): las 3 partes del Formulario 150
// de TRIBU-CR (antes D-104). Es una guía para el contador, no la declaración: él la revisa y la presenta en la OVi.
//   I. Ventas: base + IVA por tarifa (tiquetes, facturas y notas de débito; las notas de crédito restan) y exentas.
//  II. Compras: base + IVA por tarifa de las facturas de proveedor del mes (por fecha de la factura, sin anuladas);
//      solo las "acreditables" dan crédito fiscal, y se multiplica por la prorrata si hay ventas gravadas y exentas.
// III. Liquidación: débito fiscal − crédito fiscal − retenciones de IVA por tarjeta = a pagar (o saldo a favor).
// La prorrata y la retención no las sabe el sistema: se anotan a mano por mes (VatPeriod).
// Es de toda la empresa (sin filtro de sucursal): el Formulario 150 es uno por contribuyente.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma, type TaxRate } from "../../generated/prisma/client.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { TAX_PERCENT } from "../../shared/fiscal.ts"
import { logAudit } from "../audit/audit.service.ts"

const D = Prisma.Decimal
const RATES: TaxRate[] = ["RATE_13", "RATE_4", "RATE_2", "RATE_1", "EXEMPT"]
const num = (v: Prisma.Decimal | number | null | undefined) => Number(new D(v ?? 0).toDecimalPlaces(2))

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes en formato AAAA-MM")
export const vatReportQuerySchema = z.object({ month })
export const vatPeriodSchema = z.object({
  prorata: z.number().min(0).max(100).nullable(), // null = no aplica (100 %)
  cardWithholding: z.number().min(0).max(1e15),
  note: z.string().trim().max(500).nullable().optional(),
})

// Inicio del mes y del siguiente: en hora de Costa Rica para los comprobantes (issuedAt) y en UTC para las
// fechas puras (@db.Date de las facturas de proveedor)
function monthRange(m: string) {
  const [y, mo] = m.split("-").map(Number) as [number, number]
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`
  return {
    local: { gte: new Date(`${m}-01T00:00:00`), lt: new Date(`${next}-01T00:00:00`) },
    utc: { gte: new Date(`${m}-01`), lt: new Date(`${next}-01`) },
  }
}

type Row = { rate: TaxRate; percent: number; base: number; tax: number }
const emptyRows = (): Row[] => RATES.map((rate) => ({ rate, percent: TAX_PERCENT[rate], base: 0, tax: 0 }))
const sumRows = (rows: Row[]) => ({ base: num(rows.reduce((s, r) => s + r.base, 0)), tax: num(rows.reduce((s, r) => s + r.tax, 0)) })

// Ventas por tarifa del rango: lo emitido menos las notas de crédito
async function salesByRate(issuedAt: { gte: Date; lt: Date }) {
  const companyId = currentCompanyId() // DocumentLine no es modelo de empresa: se filtra por su comprobante
  const group = (type: Prisma.EnumDocumentTypeFilter) => prisma.documentLine.groupBy({
    by: ["taxRate"],
    where: { document: { companyId, issuedAt, type } },
    _sum: { subtotal: true, taxAmount: true },
  })
  const [issued, credited] = await Promise.all([group({ in: ["TICKET", "INVOICE", "DEBIT_NOTE"] }), group({ equals: "CREDIT_NOTE" })])
  const rows = new Map(RATES.map((rate) => [rate, { base: new D(0), tax: new D(0), returnsBase: new D(0), returnsTax: new D(0) }]))
  for (const g of issued) {
    const r = rows.get(g.taxRate)!
    r.base = r.base.plus(g._sum.subtotal ?? 0)
    r.tax = r.tax.plus(g._sum.taxAmount ?? 0)
  }
  for (const g of credited) {
    const r = rows.get(g.taxRate)!
    r.returnsBase = r.returnsBase.plus(g._sum.subtotal ?? 0)
    r.returnsTax = r.returnsTax.plus(g._sum.taxAmount ?? 0)
  }
  return RATES.map((rate) => {
    const r = rows.get(rate)!
    return {
      rate, percent: TAX_PERCENT[rate],
      grossBase: num(r.base), returnsBase: num(r.returnsBase),
      base: num(r.base.minus(r.returnsBase)), tax: num(r.tax.minus(r.returnsTax)),
    }
  })
}

// % de ventas gravadas sobre el total (base de la prorrata); null si no hay ventas
function prorataOf(rows: { rate: TaxRate; base: number }[]) {
  const taxed = rows.filter((r) => r.rate !== "EXEMPT").reduce((s, r) => s + r.base, 0)
  const total = taxed + (rows.find((r) => r.rate === "EXEMPT")?.base ?? 0)
  return total > 0 ? num((taxed / total) * 100) : null
}

export async function getVatReport(q: z.infer<typeof vatReportQuerySchema>) {
  const range = monthRange(q.month)
  const year = Number(q.month.slice(0, 4))
  const lastYear = { gte: new Date(`${year - 1}-01-01T00:00:00`), lt: new Date(`${year}-01-01T00:00:00`) }

  const [sales, salesLastYear, invoices, saved, inherited] = await Promise.all([
    salesByRate(range.local),
    salesByRate(lastYear),
    prisma.supplierInvoice.findMany({
      where: { voidedAt: null, issueDate: range.utc },
      select: {
        id: true, number: true, issueDate: true, subtotal: true, tax: true, total: true, creditable: true,
        supplier: { select: { id: true, name: true } },
        taxes: { select: { rate: true, base: true, tax: true } },
      },
      orderBy: [{ issueDate: "asc" }, { number: "asc" }],
    }),
    prisma.vatPeriod.findFirst({ where: { period: q.month }, include: { updatedBy: { select: { id: true, name: true } } } }),
    // la prorrata es anual: si este mes no tiene, se usa la del último mes anterior que la tenga
    prisma.vatPeriod.findFirst({ where: { period: { lt: q.month }, prorata: { not: null } }, orderBy: { period: "desc" }, select: { period: true, prorata: true } }),
  ])

  // II. compras: acreditables y no acreditables por tarifa
  const creditable = emptyRows()
  const nonCreditable = emptyRows()
  for (const inv of invoices) {
    const rows = inv.creditable ? creditable : nonCreditable
    for (const t of inv.taxes) {
      const r = rows.find((x) => x.rate === t.rate)!
      r.base += Number(t.base)
      r.tax += Number(t.tax)
    }
  }
  for (const r of [...creditable, ...nonCreditable]) {
    r.base = num(r.base)
    r.tax = num(r.tax)
  }

  // prorrata: aplica solo si el mes tiene ventas gravadas y exentas
  const exemptSales = sales.find((r) => r.rate === "EXEMPT")!.base
  const taxedSales = sales.filter((r) => r.rate !== "EXEMPT").reduce((s, r) => s + r.base, 0)
  const prorataSource = saved?.prorata != null ? "month" : inherited ? "inherited" : "none"
  const prorata = saved?.prorata != null ? Number(saved.prorata) : inherited ? Number(inherited.prorata) : null
  const purchases = sumRows(creditable)
  const credit = num(purchases.tax * (prorata ?? 100) / 100)

  // III. liquidación
  const debit = sumRows(sales).tax
  const cardWithholding = num(saved?.cardWithholding)
  const balance = num(debit - credit - cardWithholding)

  return {
    month: q.month,
    sales: { rows: sales, totals: { ...sumRows(sales), grossBase: num(sales.reduce((s, r) => s + r.grossBase, 0)), returnsBase: num(sales.reduce((s, r) => s + r.returnsBase, 0)) } },
    purchases: {
      creditable: { rows: creditable, totals: purchases },
      nonCreditable: { rows: nonCreditable, totals: sumRows(nonCreditable) },
      invoices: invoices.map((i) => ({
        id: i.id, number: i.number, issueDate: i.issueDate.toISOString().slice(0, 10), supplier: i.supplier, creditable: i.creditable,
        subtotal: num(i.subtotal), tax: num(i.tax), total: num(i.total),
        taxes: i.taxes.map((t) => ({ rate: t.rate, base: num(t.base), tax: num(t.tax) })),
      })),
    },
    prorata: {
      value: prorata, // % que se usa (null = 100 %, no aplica)
      source: prorataSource, // month | inherited (de inheritedFrom) | none
      ...(prorataSource === "inherited" && { inheritedFrom: inherited!.period }),
      applies: exemptSales > 0 && taxedSales > 0,
      suggestedMonth: prorataOf(sales),
      suggestedLastYear: prorataOf(salesLastYear),
    },
    liquidation: {
      debit, // débito fiscal (IVA de las ventas)
      creditableTax: purchases.tax, // IVA de compras acreditables antes de la prorrata
      credit, // crédito fiscal aplicado
      cardWithholding,
      balance, // > 0 a pagar; < 0 saldo a favor
      toPay: Math.max(balance, 0),
      inFavor: Math.max(-balance, 0),
    },
    period: saved ? { note: saved.note, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } : null,
  }
}

// Guarda lo que se anota a mano del mes (prorrata y retención de tarjeta)
export async function saveVatPeriod(period: string, input: z.infer<typeof vatPeriodSchema>, userId: string) {
  const data = { prorata: input.prorata, cardWithholding: input.cardWithholding, note: input.note ?? null, updatedById: userId }
  const saved = await prisma.vatPeriod.upsert({
    where: { companyId_period: { companyId: currentCompanyId(), period } },
    create: { ...data, companyId: currentCompanyId(), period },
    update: data,
  })
  await logAudit(userId, "UPDATE", "VatPeriod", saved.id, { period, prorata: input.prorata, cardWithholding: input.cardWithholding })
  return saved
}

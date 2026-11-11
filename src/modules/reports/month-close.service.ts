// Paquete para el contador, parte B: saldos AL CIERRE DEL MES (decisión del usuario del 28-oct-2026),
// reconstruidos desde la historia y no "a hoy":
//  - Cuentas por cobrar: cuotas de ventas a crédito emitidas hasta el cierre menos los abonos hechos hasta
//    el cierre. Los abonos se aplican a la cuota más vieja primero (igual que al cobrar), así que repetir
//    ese orden da lo pendiente y lo vencido por cliente.
//  - Cuentas por pagar: facturas emitidas hasta el cierre (las anuladas después del cierre se debían) menos
//    lo asignado de pagos hechos hasta el cierre.
//  - Inventario: se repiten los movimientos hasta el cierre por producto y ubicación (entrada suma, salida
//    resta, ajuste = cantidad contada) + lo que iba en tránsito entre ubicaciones.
//    Costo: no hay historia del costo promedio; se usa el de la última venta hasta el cierre (la línea guarda
//    el costo promedio de ese momento) y, si no hubo, el costo actual (`costSource` lo dice).
// Antigüedad por días de atraso al último día del mes: al día, 1-30, 31-60, 61-90, más de 90.
// ponytail: lee todos los movimientos hasta el cierre (decenas de miles en una pyme está bien); si crece,
// guardar una foto del inventario al cerrar cada mes.
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { monthRange } from "./vat-report.service.ts"

const D = Prisma.Decimal
const num = (v: Prisma.Decimal | number) => Number(new D(v).toDecimalPlaces(2))
const DAY = 86_400_000

export const AGING = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const
type Aging = Record<(typeof AGING)[number], number>
const emptyAging = (): Aging => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 })
const bucket = (days: number): keyof Aging =>
  days <= 0 ? "current" : days <= 30 ? "d1_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90_plus"
const roundAging = (a: Aging) => Object.fromEntries(AGING.map((k) => [k, num(a[k])])) as Aging

export async function getMonthClose(month: string) {
  const range = monthRange(month)
  const lastDay = new Date(range.utc.lt.getTime() - DAY) // último día del mes (fecha sin hora)
  const daysLate = (due: Date) => Math.round((lastDay.getTime() - due.getTime()) / DAY)
  const [receivables, payables, inventory] = await Promise.all([
    receivablesAt(range.local.lt, daysLate),
    payablesAt(range.utc.lt, range.local.lt, daysLate),
    inventoryAt(range.local.lt),
  ])
  return { closingDate: lastDay.toISOString().slice(0, 10), receivables, payables, inventory }
}

async function receivablesAt(end: Date, daysLate: (d: Date) => number) {
  const [installments, payments] = await Promise.all([
    prisma.installment.findMany({
      where: { document: { issuedAt: { lt: end } } },
      select: {
        customerId: true, dueDate: true, amount: true,
        customer: { select: { name: true, idNumber: true } },
        document: { select: { consecutive: true } },
      },
      orderBy: [{ dueDate: "asc" }, { number: "asc" }],
    }),
    prisma.customerPayment.groupBy({ by: ["customerId"], where: { createdAt: { lt: end } }, _sum: { amount: true } }),
  ])
  const paidBy = new Map(payments.map((p) => [p.customerId, new D(p._sum.amount ?? 0)]))
  const byCustomer = new Map<string, { customer: { id: string; name: string; idNumber: string | null }; balance: Prisma.Decimal; aging: Aging; documents: Set<string>; oldestDue: Date | null }>()
  for (const i of installments) {
    // los abonos cubren las cuotas en orden: lo que queda de cada una es lo que se debía al cierre
    const left = paidBy.get(i.customerId) ?? new D(0)
    const covered = D.min(left, i.amount)
    paidBy.set(i.customerId, left.minus(covered))
    const owed = i.amount.minus(covered)
    if (!owed.greaterThan(0)) continue
    const row = byCustomer.get(i.customerId) ?? {
      customer: { id: i.customerId, name: i.customer.name, idNumber: i.customer.idNumber },
      balance: new D(0), aging: emptyAging(), documents: new Set<string>(), oldestDue: null,
    }
    row.balance = row.balance.plus(owed)
    row.aging[bucket(daysLate(i.dueDate))] += Number(owed)
    row.documents.add(i.document.consecutive)
    row.oldestDue ??= i.dueDate
    byCustomer.set(i.customerId, row)
  }
  const customers = [...byCustomer.values()]
    .map((r) => ({
      customer: r.customer, balance: num(r.balance), overdue: num(r.balance.minus(r.aging.current)),
      aging: roundAging(r.aging), documents: [...r.documents], oldestDue: r.oldestDue!.toISOString().slice(0, 10),
    }))
    .sort((a, b) => b.balance - a.balance || a.customer.name.localeCompare(b.customer.name))
  return { customers, totals: totalsOf(customers) }
}

async function payablesAt(endDate: Date, end: Date, daysLate: (d: Date) => number) {
  const invoices = await prisma.supplierInvoice.findMany({
    where: { issueDate: { lt: endDate }, OR: [{ voidedAt: null }, { voidedAt: { gte: end } }] },
    select: {
      id: true, number: true, issueDate: true, dueDate: true, total: true, creditable: true,
      supplier: { select: { id: true, name: true, idNumber: true } },
      allocations: { where: { payment: { paidAt: { lt: endDate } } }, select: { amount: true } },
    },
    orderBy: [{ dueDate: "asc" }, { number: "asc" }],
  })
  const rows = invoices
    .map((i) => {
      const paid = i.allocations.reduce((s, a) => s.plus(a.amount), new D(0))
      const balance = i.total.minus(paid)
      const late = daysLate(i.dueDate)
      return {
        id: i.id, supplier: i.supplier, number: i.number,
        issueDate: i.issueDate.toISOString().slice(0, 10), dueDate: i.dueDate.toISOString().slice(0, 10),
        total: num(i.total), paid: num(paid), balance: num(balance), daysLate: Math.max(late, 0), bucket: bucket(late),
      }
    })
    .filter((r) => r.balance > 0)
  const aging = emptyAging()
  for (const r of rows) aging[r.bucket] += r.balance
  const balance = num(rows.reduce((s, r) => s + r.balance, 0))
  return { invoices: rows, totals: { count: rows.length, balance, overdue: num(balance - aging.current), aging: roundAging(aging) } }
}

function totalsOf(customers: { balance: number; overdue: number; aging: Aging }[]) {
  const aging = emptyAging()
  for (const c of customers) for (const k of AGING) aging[k] += c.aging[k]
  return {
    count: customers.length,
    balance: num(customers.reduce((s, c) => s + c.balance, 0)),
    overdue: num(customers.reduce((s, c) => s + c.overdue, 0)),
    aging: roundAging(aging),
  }
}

async function inventoryAt(end: Date) {
  const companyId = currentCompanyId() // DocumentLine no es modelo de empresa: se filtra por su comprobante
  const [movements, lastCosts] = await Promise.all([
    prisma.stockMovement.findMany({
      where: { createdAt: { lt: end } },
      select: { productId: true, locationId: true, type: true, quantity: true, source: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.$queryRaw<{ productId: string; unitCost: Prisma.Decimal }[]>`
      SELECT DISTINCT ON (l."productId") l."productId", l."unitCost"
      FROM "DocumentLine" l JOIN "Document" d ON d.id = l."documentId"
      WHERE d."companyId" = ${companyId} AND d."issuedAt" < ${end} AND d.type <> 'CREDIT_NOTE'
        AND l."productId" IS NOT NULL AND l."unitCost" IS NOT NULL
      ORDER BY l."productId", d."issuedAt" DESC`,
  ])
  // cantidad por producto y ubicación, y lo que iba en camino entre ubicaciones
  const at = new Map<string, Prisma.Decimal>()
  const transit = new Map<string, Prisma.Decimal>()
  for (const m of movements) {
    const key = `${m.productId}|${m.locationId}`
    const current = at.get(key) ?? new D(0)
    at.set(key, m.type === "ADJUSTMENT" ? m.quantity : m.type === "IN" ? current.plus(m.quantity) : current.minus(m.quantity))
    if (m.source === "TRANSFER") {
      const t = transit.get(m.productId) ?? new D(0)
      transit.set(m.productId, m.type === "OUT" ? t.plus(m.quantity) : t.minus(m.quantity))
    }
  }
  const qty = new Map<string, { total: Prisma.Decimal; byLocation: Map<string, Prisma.Decimal> }>()
  for (const [key, q] of at) {
    const [productId, locationId] = key.split("|") as [string, string]
    const p = qty.get(productId) ?? { total: new D(0), byLocation: new Map() }
    p.total = p.total.plus(q)
    if (!q.isZero()) p.byLocation.set(locationId, q)
    qty.set(productId, p)
  }
  for (const [productId, t] of transit) {
    const p = qty.get(productId)
    if (p) p.total = p.total.plus(t)
  }
  const ids = [...qty].filter(([, p]) => !p.total.isZero()).map(([id]) => id)
  const [products, locations] = await Promise.all([
    prisma.product.findMany({
      // igual que el inventario valorizado de hoy, sin los eliminados; los eliminados después del cierre sí estaban
      where: { id: { in: ids }, OR: [{ deletedAt: null }, { deletedAt: { gte: end } }] },
      select: { id: true, sku: true, name: true, unit: true, cost: true, category: { select: { name: true } } },
    }),
    prisma.location.findMany({ select: { id: true, name: true } }),
  ])
  const saleCost = new Map(lastCosts.map((c) => [c.productId, c.unitCost]))
  const locationName = new Map(locations.map((l) => [l.id, l.name]))
  const items = products
    .map((p) => {
      const q = qty.get(p.id)!
      const fromSale = saleCost.get(p.id)
      const cost = fromSale ?? p.cost
      const inTransit = transit.get(p.id) ?? new D(0)
      return {
        product: { id: p.id, sku: p.sku, name: p.name, unit: p.unit, category: p.category.name },
        quantity: Number(q.total),
        inTransit: Number(inTransit),
        byLocation: [...q.byLocation].map(([id, v]) => ({ location: locationName.get(id) ?? id, quantity: Number(v) })),
        unitCost: cost == null ? null : Number(new D(cost).toDecimalPlaces(4)),
        costSource: fromSale ? "sale" : cost == null ? "none" : "current",
        value: cost == null ? null : num(q.total.times(cost)),
      }
    })
    .sort((a, b) => a.product.category.localeCompare(b.product.category) || a.product.name.localeCompare(b.product.name))
  return {
    items,
    totals: {
      count: items.length,
      value: num(items.reduce((s, i) => s + (i.value ?? 0), 0)),
      withoutCost: items.filter((i) => i.unitCost == null).length,
      negative: items.filter((i) => i.quantity < 0).length,
    },
  }
}

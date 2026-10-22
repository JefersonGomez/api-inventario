// Reporte de ventas (Bloque 7D-1, decisiones del usuario del 20-oct-2026): lo ve quien tiene reports.view;
// la ganancia estimada solo con costs.view. El cajero ve sus propias ventas del mes (comisiones).
// Ventas = tiquetes y facturas; devoluciones = notas de crédito. Montos con IVA, como los ve el cliente.
// Los días son los de Costa Rica (config/timezone.ts fija la zona del proceso).
// ponytail: agrupa en memoria los comprobantes del período (miles por mes en una pyme); pasar a SQL si crece.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { withScopedStock } from "../locations/stock-scope.ts"
import { TAX_PERCENT } from "../../shared/fiscal.ts"

const D = Prisma.Decimal
const SALES = ["TICKET", "INVOICE"] as const
const DAY = 86_400_000

export const salesReportQuerySchema = z.object({ from: z.iso.date(), to: z.iso.date() })
export const mySalesQuerySchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, "Mes en formato AAAA-MM").optional() })

const dayStart = (d: string) => new Date(`${d}T00:00:00`)
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`)
const dayKey = (d: Date) => d.toLocaleDateString("sv")
const num = (v: Prisma.Decimal | number | null | undefined) => Number(new D(v ?? 0).toDecimalPlaces(2))

// Comprobantes de venta y notas de un período, en las ubicaciones de la persona
function docWhere(from: Date, to: Date, extra: Prisma.DocumentWhereInput = {}): Prisma.DocumentWhereInput {
  const scope = locationScope()
  return {
    companyId: currentCompanyId(), // también lo usan groupBy de líneas y pagos (no son modelos de empresa)
    issuedAt: { gte: from, lte: to },
    type: { in: [...SALES, "CREDIT_NOTE"] },
    ...(scope && { cashSession: { register: { locationId: { in: scope } } } }),
    ...extra,
  }
}

// Totales de un período: vendido, devuelto, neto y tiquetes
async function totalsFor(from: Date, to: Date, extra: Prisma.DocumentWhereInput = {}) {
  const rows = await prisma.document.groupBy({ by: ["type"], where: docWhere(from, to, extra), _sum: { total: true }, _count: true })
  const sales = rows.filter((r) => r.type !== "CREDIT_NOTE")
  const gross = sales.reduce((s, r) => s.plus(r._sum.total ?? 0), new D(0))
  const returns = new D(rows.find((r) => r.type === "CREDIT_NOTE")?._sum.total ?? 0)
  const tickets = sales.reduce((s, r) => s + r._count, 0)
  return { gross: num(gross), returns: num(returns), net: num(gross.minus(returns)), tickets, average: tickets ? num(gross.div(tickets)) : 0 }
}

export async function getSalesReport(q: z.infer<typeof salesReportQuerySchema>, user: { permissions: string[] }) {
  const from = dayStart(q.from)
  const to = dayEnd(q.to)
  if (to < from) throw new Error("La fecha final es anterior a la inicial")
  const days = Math.round((to.getTime() - from.getTime()) / DAY)
  if (days > 366) throw new Error("El período máximo es de un año")
  // período anterior del mismo largo, para comparar
  const prevTo = new Date(from.getTime() - 1)
  const prevFrom = new Date(from.getTime() - days * DAY)
  const where = docWhere(from, to)

  const [totals, previous, docs, payments, lines, noteLines, discounted] = await Promise.all([
    totalsFor(from, to),
    totalsFor(prevFrom, prevTo),
    prisma.document.findMany({
      where,
      select: {
        type: true, issuedAt: true, total: true, createdById: true, saleCondition: true,
        createdBy: { select: { id: true, name: true } },
        cashSession: { select: { register: { select: { id: true, name: true, location: { select: { name: true } } } } } },
      },
    }),
    prisma.documentPayment.groupBy({ by: ["method"], where: { document: { ...where, type: { in: [...SALES] } } }, _sum: { amount: true } }),
    // por producto: lo vendido y lo devuelto (con IVA), y la base sin IVA para la ganancia
    prisma.documentLine.groupBy({
      by: ["productId", "description"],
      where: { document: { ...where, type: { in: [...SALES] } } },
      _sum: { quantity: true, total: true, subtotal: true },
    }),
    prisma.documentLine.groupBy({
      by: ["productId", "description"],
      where: { document: { ...where, type: "CREDIT_NOTE" } },
      _sum: { quantity: true, total: true, subtotal: true },
    }),
    prisma.documentLine.findMany({
      where: { discount: { gt: 0 }, document: { ...where, type: { in: [...SALES] } } },
      select: { discount: true, taxRate: true, document: { select: { discountAuthorizedBy: { select: { id: true, name: true } } } } },
    }),
  ])

  // por día, cajero y caja (ventas menos devoluciones)
  const byDay = new Map<string, { gross: number; returns: number; tickets: number }>()
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) byDay.set(dayKey(new Date(t)), { gross: 0, returns: 0, tickets: 0 })
  const byCashier = new Map<string, { id: string; name: string; gross: number; returns: number; tickets: number }>()
  const byRegister = new Map<string, { id: string; name: string; gross: number; returns: number; tickets: number }>()
  let creditSales = 0
  for (const d of docs) {
    const total = Number(d.total)
    const isReturn = d.type === "CREDIT_NOTE"
    const add = (row: { gross: number; returns: number; tickets: number } | undefined) => {
      if (!row) return
      if (isReturn) row.returns += total
      else {
        row.gross += total
        row.tickets += 1
      }
    }
    add(byDay.get(dayKey(d.issuedAt)))
    if (!byCashier.has(d.createdById)) byCashier.set(d.createdById, { ...d.createdBy, gross: 0, returns: 0, tickets: 0 })
    add(byCashier.get(d.createdById))
    const reg = d.cashSession?.register
    const regKey = reg?.id ?? "none"
    if (!byRegister.has(regKey)) byRegister.set(regKey, { id: regKey, name: reg ? `${reg.name} · ${reg.location.name}` : "", gross: 0, returns: 0, tickets: 0 })
    add(byRegister.get(regKey))
    if (!isReturn && d.saleCondition === "CREDIT") creditSales += total
  }
  const round = <T extends { gross: number; returns: number }>(r: T) => ({ ...r, gross: num(r.gross), returns: num(r.returns), net: num(r.gross - r.returns) })

  // medios de pago: lo cobrado en la venta; lo que se fue a cuotas es "crédito"
  const paid = Object.fromEntries(payments.map((p) => [p.method, num(p._sum.amount)]))
  const paidTotal = Object.values(paid).reduce((s, v) => s + v, 0)
  const byMethod = { ...paid, ...(creditSales > 0 && { CREDIT: num(totals.gross - paidTotal) }) }

  // descuentos con IVA, por quién los autorizó
  const discounts = new Map<string, { id: string; name: string; amount: number; lines: number }>()
  for (const l of discounted) {
    const who = l.document.discountAuthorizedBy ?? { id: "none", name: "" }
    const row = discounts.get(who.id) ?? { ...who, amount: 0, lines: 0 }
    row.amount += Number(l.discount) * (1 + TAX_PERCENT[l.taxRate] / 100)
    row.lines += 1
    discounts.set(who.id, row)
  }

  // productos: neto = vendido − devuelto (por producto; las líneas libres, por descripción)
  const key = (l: { productId: string | null; description: string }) => l.productId ?? `free:${l.description}`
  const top = new Map<string, { productId: string | null; name: string; quantity: number; amount: number; base: number }>()
  for (const [list, sign] of [[lines, 1], [noteLines, -1]] as const) {
    for (const l of list) {
      const row = top.get(key(l)) ?? { productId: l.productId, name: l.description, quantity: 0, amount: 0, base: 0 }
      row.quantity += sign * Number(l._sum.quantity ?? 0)
      row.amount += sign * Number(l._sum.total ?? 0)
      row.base += sign * Number(l._sum.subtotal ?? 0)
      top.set(key(l), row)
    }
  }

  // ganancia (costs.view): venta sin IVA menos el costo guardado en cada línea al vender. Las devoluciones
  // restan su venta; su costo solo vuelve si el producto volvió en buen estado (lo dañado es pérdida).
  // Las ventas anteriores a guardar el costo (sin unitCost) usan el costo promedio actual del producto.
  let profit: { revenue: number; cost: number; profit: number; margin: number; withoutCost: number } | null = null
  const ids = [...top.values()].flatMap((r) => (r.productId ? [r.productId] : []))
  if (user.permissions.includes("costs.view")) {
    const [soldRows, backRows] = await Promise.all([
      prisma.documentLine.groupBy({
        by: ["productId", "description", "unitCost"],
        where: { document: { ...where, type: { in: [...SALES] } } },
        _sum: { quantity: true, subtotal: true },
      }),
      prisma.documentLine.groupBy({
        by: ["productId", "description", "unitCost", "returnCondition"],
        where: { document: { ...where, type: "CREDIT_NOTE" } },
        _sum: { quantity: true, subtotal: true },
      }),
    ])
    const oldIds = [...new Set([...soldRows, ...backRows].flatMap((r) => (r.unitCost == null && r.productId ? [r.productId] : [])))]
    const current = new Map(
      (oldIds.length ? await prisma.product.findMany({ where: { id: { in: oldIds } }, select: { id: true, cost: true } }) : []).map((p) => [p.id, p.cost])
    )
    const costOf = (r: { productId: string | null; unitCost: Prisma.Decimal | null }) => r.unitCost ?? (r.productId ? current.get(r.productId) : null) ?? null
    let revenue = 0
    let cost = 0
    const withoutCost = new Set<string>()
    for (const r of soldRows) {
      const c = costOf(r)
      if (c == null) {
        withoutCost.add(key(r))
        continue
      }
      revenue += Number(r._sum.subtotal ?? 0)
      cost += Number(c) * Number(r._sum.quantity ?? 0)
    }
    for (const r of backRows) {
      const c = costOf(r)
      if (c == null) continue // su venta tampoco se contó
      revenue -= Number(r._sum.subtotal ?? 0)
      if (r.returnCondition !== "DAMAGED") cost -= Number(c) * Number(r._sum.quantity ?? 0)
    }
    profit = { revenue: num(revenue), cost: num(cost), profit: num(revenue - cost), margin: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0, withoutCost: withoutCost.size }
  }

  // sin ventas: productos con stock (en las ubicaciones que se ven) que no se vendieron en el período
  const scope = locationScope()
  const candidates = await prisma.product.findMany({
    where: { deletedAt: null, id: { notIn: ids }, ...(!scope && { stock: { gt: 0 } }) },
    select: { id: true, sku: true, name: true, stock: true, unit: true, price: true },
  })
  const still = (await withScopedStock(candidates, scope))
    .map((p) => ({ ...p, stock: Number(p.stock) }))
    .filter((p) => p.stock > 0)
    .sort((a, b) => b.stock - a.stock)
    .slice(0, 50)

  const products = [...top.values()]
    .filter((r) => r.quantity > 0 || r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map(({ base: _base, ...r }) => ({ ...r, quantity: Math.round(r.quantity * 1000) / 1000, amount: num(r.amount) }))

  return {
    from: q.from, to: q.to,
    totals, previous,
    byDay: [...byDay].map(([date, r]) => ({ date, ...round(r) })),
    byMethod,
    byCashier: [...byCashier.values()].map(round).sort((a, b) => b.net - a.net),
    byRegister: [...byRegister.values()].map(round).sort((a, b) => b.net - a.net),
    discounts: { total: num([...discounts.values()].reduce((s, r) => s + r.amount, 0)), byAuthorizer: [...discounts.values()].map((r) => ({ ...r, amount: num(r.amount) })) },
    profit,
    products: products.slice(0, 100),
    notSold: still.map((p) => ({ ...p, price: Number(p.price) })),
  }
}

// Panel: ventas de hoy y de ayer (mismas horas no: el día completo de ayer)
export async function getSalesToday() {
  const today = dayKey(new Date())
  const yesterday = dayKey(new Date(Date.now() - DAY))
  const [now, before] = await Promise.all([
    totalsFor(dayStart(today), dayEnd(today)),
    totalsFor(dayStart(yesterday), dayEnd(yesterday)),
  ])
  return { today: now, yesterday: before }
}

// El cajero: sus ventas del mes y lo devuelto de ellas (para comisiones)
export async function getMySales(q: z.infer<typeof mySalesQuerySchema>, userId: string) {
  const month = q.month ?? dayKey(new Date()).slice(0, 7)
  const [y, m] = month.split("-").map(Number) as [number, number]
  const from = new Date(y, m - 1, 1)
  const to = new Date(y, m, 0, 23, 59, 59, 999)
  const [sales, returns] = await Promise.all([
    prisma.document.findMany({
      where: { createdById: userId, type: { in: [...SALES] }, issuedAt: { gte: from, lte: to } },
      select: { issuedAt: true, total: true },
    }),
    // devoluciones de SUS ventas (las haga quien las haga), en el mismo mes
    prisma.document.aggregate({
      where: { type: "CREDIT_NOTE", issuedAt: { gte: from, lte: to }, referenceDocument: { createdById: userId } },
      _sum: { total: true },
      _count: true,
    }),
  ])
  const byDay = new Map<string, { gross: number; tickets: number }>()
  for (const s of sales) {
    const k = dayKey(s.issuedAt)
    const row = byDay.get(k) ?? { gross: 0, tickets: 0 }
    row.gross += Number(s.total)
    row.tickets += 1
    byDay.set(k, row)
  }
  const gross = sales.reduce((s, d) => s + Number(d.total), 0)
  const back = Number(returns._sum.total ?? 0)
  return {
    month,
    gross: num(gross), returns: num(back), net: num(gross - back), tickets: sales.length, returnsCount: returns._count,
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, r]) => ({ date, gross: num(r.gross), tickets: r.tickets })),
  }
}

// Resumen del día con IA: ventas, devoluciones, abonos, cuotas vencidas, más vendidos y arqueos con diferencia
// desde `since` (inicio del día). De toda la empresa y sin costos, como el resto del resumen.
export async function salesOfDay(since: Date) {
  const now = new Date()
  const where = { companyId: currentCompanyId(), issuedAt: { gte: since, lte: now } }
  const [totals, top, collections, overdue, reconciled] = await Promise.all([
    totalsFor(since, now),
    prisma.documentLine.groupBy({
      by: ["description"],
      where: { document: { ...where, type: { in: [...SALES] } } },
      _sum: { total: true },
      orderBy: { _sum: { total: "desc" } },
      take: 3,
    }),
    prisma.customerPayment.aggregate({ where: { createdAt: { gte: since } }, _sum: { amount: true }, _count: true }),
    prisma.installment.count({ where: { dueDate: { lt: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) }, paid: { lt: prisma.installment.fields.amount } } }),
    prisma.cashSession.findMany({ where: { reconciledAt: { gte: since }, difference: { not: 0 } }, select: { difference: true } }),
  ])
  return {
    ...totals,
    topProducts: top.map((t) => t.description),
    collections: num(collections._sum.amount), collectionsCount: collections._count,
    overdueInstallments: overdue,
    cashDifferences: reconciled.length,
    cashDifferenceTotal: num(reconciled.reduce((s, r) => s + Number(r.difference ?? 0), 0)),
  }
}

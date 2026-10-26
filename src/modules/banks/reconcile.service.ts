// Conciliación bancaria (Bloque 10, punto 53B; decisiones del usuario del 25-oct-2026):
//  - El sistema arma lo que ESPERA ver en cada cuenta: SINPE/transferencias de ventas y reembolsos,
//    abonos de clientes, pagos a proveedores, depósitos de efectivo y la tarjeta de cada día (lote).
//  - Sugiere parejas con lo importado del banco (monto exacto y fecha ±3 días; la referencia gana;
//    tarjeta: entra 0–5 días después, hasta 10 % menos por la comisión). Nada se concilia solo:
//    la persona confirma (POST /banks/transactions/:id/match) y puede deshacerlo.
//  - Lo que está en el sistema y no aparece en el banco después del plazo se lista aparte
//    (p. ej. un comprobante SINPE que nunca entró).
// A qué cuenta va cada cosa: la de la sucursal (Location.bankAccountId) o la de la empresa.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import type { BankMatchType } from "../../generated/prisma/enums.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { logAudit } from "../audit/audit.service.ts"
import { pageQuery, pageResult } from "../../shared/pagination.ts"

const DAY = 86_400_000
const fail = (message: string, status: number) => Object.assign(new Error(message), { status })
const dateOnly = (d: string) => new Date(`${d}T00:00:00Z`)
// día de la venta en la hora del servidor (como el reporte de ventas); las fechas @db.Date vienen en UTC
const localDay = (d: Date) => d.toLocaleDateString("sv")
const utcDay = (d: Date) => d.toISOString().slice(0, 10)
const days = (a: string, b: string) => Math.round((dateOnly(a).getTime() - dateOnly(b).getTime()) / DAY)
const round2 = (n: number) => Math.round(n * 100) / 100
const SALE_DAYS = 3 // ± días entre el sistema y el banco
const CARD_DAYS = 5 // la tarjeta se liquida hasta 5 días después
const CARD_FEE = 0.1 // y puede llegar hasta 10 % menos (comisión)

const MAX_DAYS = 92 // rango máximo: arma lo esperado de todo el rango en memoria
export const reconcileQuerySchema = z.object({ page: pageQuery.page, pageSize: pageQuery.pageSize, from: z.iso.date(), to: z.iso.date() })
export const matchSchema = z.object({
  items: z.array(z.object({
    type: z.enum(["SALE_PAYMENT", "CUSTOMER_PAYMENT", "SUPPLIER_PAYMENT", "CASH_DEPOSIT", "CARD_BATCH"]),
    id: z.string().min(1).max(80),
  })).min(1).max(50),
})

export type ExpectedItem = {
  type: BankMatchType
  id: string
  date: string // AAAA-MM-DD
  amount: number // con signo: + entra, − sale
  reference: string | null
  label: string // documento, cliente, proveedor o sucursal
}

const key = (i: { type: string; id: string }) => `${i.type}:${i.id}`

// Lo que el sistema espera ver en la cuenta entre dos fechas (sin lo ya conciliado)
export async function expectedItems(accountId: string, from: Date, to: Date): Promise<ExpectedItem[]> {
  const companyId = currentCompanyId()
  const [company, locations] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { bankAccountId: true } }),
    prisma.location.findMany({ select: { id: true, name: true, code: true, bankAccountId: true } }),
  ])
  const accountOf = (locationId: string | null | undefined) =>
    (locationId && locations.find((l) => l.id === locationId)?.bankAccountId) || company.bankAccountId
  const locationByCode = new Map(locations.map((l) => [l.code, l.id]))
  const isDefault = company.bankAccountId === accountId
  const range = { gte: from, lte: new Date(to.getTime() + DAY - 1) }

  const [salePayments, customerPayments, supplierPayments, deposits, matched] = await Promise.all([
    // DocumentPayment no tiene companyId: se filtra por su documento
    prisma.documentPayment.findMany({
      where: { method: { in: ["SINPE", "TRANSFER", "CARD"] }, document: { companyId, issuedAt: range } },
      select: {
        id: true, method: true, amount: true, reference: true,
        document: { select: { type: true, consecutive: true, issuedAt: true, branchCode: true, cashSession: { select: { register: { select: { locationId: true } } } } } },
      },
    }),
    prisma.customerPayment.findMany({
      where: { method: { in: ["SINPE", "TRANSFER", "CARD"] }, createdAt: range },
      select: {
        id: true, method: true, amount: true, reference: true, createdAt: true, bankAccountId: true,
        customer: { select: { name: true } }, cashSession: { select: { register: { select: { locationId: true } } } },
      },
    }),
    prisma.supplierPayment.findMany({
      where: { method: { not: "CASH" }, paidAt: range, ...(isDefault ? { OR: [{ bankAccountId: accountId }, { bankAccountId: null }] } : { bankAccountId: accountId }) },
      select: { id: true, amount: true, reference: true, paidAt: true, supplier: { select: { name: true } } },
    }),
    prisma.cashDeposit.findMany({
      where: { bankAccountId: accountId, depositedAt: range },
      select: { id: true, amount: true, reference: true, depositedAt: true, location: { select: { name: true } } },
    }),
    prisma.bankMatch.findMany({ where: { transaction: { companyId } }, select: { sourceType: true, sourceId: true } }),
  ])

  const items: ExpectedItem[] = []
  const cards = new Map<string, number>() // día → total con tarjeta
  for (const p of salePayments) {
    const d = p.document
    const locationId = d.cashSession?.register.locationId ?? locationByCode.get(d.branchCode)
    if (accountOf(locationId) !== accountId) continue
    const amount = round2(Number(p.amount)) * (d.type === "CREDIT_NOTE" ? -1 : 1) // la nota de crédito = reembolso
    const day = localDay(d.issuedAt)
    if (p.method === "CARD") cards.set(day, round2((cards.get(day) ?? 0) + amount))
    else items.push({ type: "SALE_PAYMENT", id: p.id, date: day, amount, reference: p.reference, label: d.consecutive })
  }
  for (const p of customerPayments) {
    const account = p.bankAccountId ?? accountOf(p.cashSession?.register.locationId)
    if (account !== accountId) continue
    const day = localDay(p.createdAt)
    // tarjeta en la caja: va al lote del día con las ventas
    if (p.method === "CARD" && p.cashSession) cards.set(day, round2((cards.get(day) ?? 0) + Number(p.amount)))
    else items.push({ type: "CUSTOMER_PAYMENT", id: p.id, date: day, amount: Number(p.amount), reference: p.reference, label: p.customer.name })
  }
  for (const p of supplierPayments) {
    items.push({ type: "SUPPLIER_PAYMENT", id: p.id, date: utcDay(p.paidAt), amount: -Number(p.amount), reference: p.reference, label: p.supplier.name })
  }
  for (const d of deposits) {
    items.push({ type: "CASH_DEPOSIT", id: d.id, date: utcDay(d.depositedAt), amount: Number(d.amount), reference: d.reference, label: d.location?.name ?? "" })
  }
  for (const [day, amount] of cards) {
    if (amount > 0) items.push({ type: "CARD_BATCH", id: `${accountId}:${day}`, date: day, amount, reference: null, label: day })
  }
  const done = new Set(matched.map((m) => key({ type: m.sourceType, id: m.sourceId })))
  return items.filter((i) => !done.has(key(i)))
}

type BankRow = { id: string; date: Date; amount: { toNumber(): number }; reference: string; description: string }

// ¿Puede este movimiento del banco ser esta cosa del sistema? Devuelve un puntaje (menor = mejor) o null.
function score(t: BankRow, item: ExpectedItem) {
  const bank = t.amount.toNumber()
  const gap = days(utcDay(t.date), item.date)
  if (item.type === "CARD_BATCH") {
    const fits = bank > 0 && bank <= item.amount + 0.005 && bank >= item.amount * (1 - CARD_FEE) && gap >= 0 && gap <= CARD_DAYS
    return fits ? 20 + gap + (bank === item.amount ? 0 : 1) : null
  }
  if (Math.abs(bank - item.amount) > 0.005 || Math.abs(gap) > SALE_DAYS) return null
  // la referencia del sistema (comprobante SINPE, n.º de transferencia) aparece en la del banco o en la descripción
  const ref = item.reference?.replace(/\D/g, "") ?? ""
  const sameRef = ref.length >= 4 && (t.reference.includes(ref) || t.description.replace(/\D/g, " ").split(" ").some((n) => n.length >= 4 && (n.endsWith(ref) || ref.endsWith(n))))
  return (sameRef ? 0 : 10) + Math.abs(gap)
}

// Sugerencias para lo pendiente del banco entre dos fechas + lo del sistema que no aparece en el banco
export async function reconcile(accountId: string, q: z.infer<typeof reconcileQuerySchema>) {
  const account = await prisma.bankAccount.findFirst({ where: { id: accountId }, select: { id: true } })
  if (!account) throw fail("Cuenta bancaria no encontrada", 404)
  const from = dateOnly(q.from)
  const to = dateOnly(q.to)
  if (to < from) throw new Error("La fecha final es anterior a la inicial")
  if ((to.getTime() - from.getTime()) / DAY > MAX_DAYS) throw new Error("Elegí un rango de hasta 3 meses")
  const [pending, items] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { bankAccountId: accountId, reviewedAt: null, date: { gte: from, lte: to } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: { id: true, date: true, amount: true, reference: true, description: true },
    }),
    // el sistema un poco antes y después: lo del banco puede caer días después (tarjeta) o antes
    expectedItems(accountId, new Date(from.getTime() - CARD_DAYS * DAY), new Date(to.getTime() + SALE_DAYS * DAY)),
  ])

  // todas las parejas posibles, la mejor primero; cada lado se usa una sola vez en la sugerencia
  const pairs = pending.flatMap((t) => items.map((i) => ({ t, i, s: score(t, i) }))).filter((p) => p.s !== null)
  pairs.sort((a, b) => a.s! - b.s!)
  const usedT = new Set<string>()
  const usedI = new Set<string>()
  const suggested = new Map<string, ExpectedItem>()
  for (const { t, i } of pairs) {
    if (usedT.has(t.id) || usedI.has(key(i))) continue
    usedT.add(t.id)
    usedI.add(key(i))
    suggested.set(t.id, i)
  }
  const candidatesOf = (id: string) => pairs.filter((p) => p.t.id === id).slice(0, 6).map((p) => p.i)

  // en el sistema y no en el banco: dentro del rango, ya pasado el plazo y sin sugerencia
  const today = utcDay(new Date())
  const missing = items.filter(
    (i) => i.date >= q.from && i.date <= q.to && !usedI.has(key(i)) && days(today, i.date) > (i.type === "CARD_BATCH" ? CARD_DAYS : SALE_DAYS)
  )
  // las sugerencias se calculan con todo el rango (cada pareja una sola vez); se devuelve una página
  const page = pending.slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
  return {
    ...pageResult(
      page.map((t) => ({ ...t, suggestion: suggested.get(t.id) ?? null, candidates: candidatesOf(t.id) })),
      pending.length,
      q
    ),
    suggested: suggested.size,
    // ponytail: lo que falta en el banco va completo (suele ser poco); paginarlo si crece
    missing: missing.sort((a, b) => a.date.localeCompare(b.date)),
  }
}

// Confirmar: este movimiento del banco = estas cosas del sistema. La suma tiene que dar exacto,
// salvo con lotes de tarjeta, donde lo que falta (hasta 10 %) queda como comisión.
export async function confirmMatch(transactionId: string, input: z.infer<typeof matchSchema>, userId: string) {
  const t = await prisma.bankTransaction.findFirst({ where: { id: transactionId } })
  if (!t) throw fail("Movimiento no encontrado", 404)
  if (t.reviewedAt) throw new Error("El movimiento ya está revisado: deshacé primero lo que tiene")
  const around = (n: number) => new Date(t.date.getTime() + n * DAY)
  const available = new Map((await expectedItems(t.bankAccountId, around(-30), around(30))).map((i) => [key(i), i]))
  const chosen = input.items.map((i) => available.get(key(i)))
  if (chosen.some((i) => !i)) throw new Error("Algo de lo elegido ya está conciliado o no es de esta cuenta")
  const items = chosen as ExpectedItem[]
  if (new Set(items.map(key)).size !== items.length) throw new Error("Hay elementos repetidos")

  const expected = round2(items.reduce((s, i) => s + i.amount, 0))
  const bank = t.amount.toNumber()
  const allCards = items.every((i) => i.type === "CARD_BATCH")
  const fee = allCards ? round2(expected - bank) : 0
  if (allCards ? fee < -0.005 || bank < expected * (1 - CARD_FEE) : Math.abs(expected - bank) > 0.005) {
    throw new Error(`No cuadra: el banco dice ${bank.toFixed(2)} y lo elegido suma ${expected.toFixed(2)}`)
  }

  return prisma.$transaction(async (tx) => {
    await tx.bankMatch.createMany({
      data: items.map((i) => ({ bankTransactionId: t.id, sourceType: i.type, sourceId: i.id, amount: i.amount, label: i.label })),
    })
    const saved = await tx.bankTransaction.update({
      where: { id: t.id },
      data: { reviewedAt: new Date(), reviewedById: userId, category: null, fee: fee > 0 ? fee : null },
      include: { matches: true },
    })
    await logAudit(userId, "UPDATE", "BankTransaction", t.id, { matched: items.map(key), fee }, tx)
    return saved
  })
}

// Deshacer la conciliación (o la clasificación) de un movimiento: vuelve a pendiente
export async function undoMatch(transactionId: string, userId: string) {
  const t = await prisma.bankTransaction.findFirst({ where: { id: transactionId }, select: { id: true } })
  if (!t) throw fail("Movimiento no encontrado", 404)
  return prisma.$transaction(async (tx) => {
    await tx.bankMatch.deleteMany({ where: { bankTransactionId: t.id } })
    const saved = await tx.bankTransaction.update({
      where: { id: t.id },
      data: { reviewedAt: null, reviewedById: null, category: null, fee: null },
    })
    await logAudit(userId, "UPDATE", "BankTransaction", t.id, { undone: true }, tx)
    return saved
  })
}

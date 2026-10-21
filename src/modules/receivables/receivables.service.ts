// Crédito y cuentas por cobrar (Bloque 7B-2, decisiones del usuario del 20-oct-2026):
//  - Solo quien tiene credit.manage (el admin) habilita el crédito de un cliente y fija su límite; el
//    cliente necesita identificación.
//  - Venta a crédito en la caja: con el código del encargado (sales.credit), plan quincenal o mensual
//    hasta 6 meses, sin intereses. Bloqueo sin excepción si pasa el límite o tiene cuotas vencidas.
//  - Abonos: en la caja (el efectivo entra al arqueo) o desde Cuentas por cobrar sin caja, con referencia
//    (receivables.manage). Se aplican a la cuota más vieja primero. El recibo lleva saldo anterior y nuevo.
//  - Cuotas vencidas: aviso a quien maneja los cobros (una vez por cuota).
import { z } from "zod"
import { prisma, prismaRoot, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, runWithCompany } from "../../shared/tenant.ts"
import { pageQuery, pageResult } from "../../shared/pagination.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"

const D = Prisma.Decimal
const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
type Actor = { id: string; permissions: string[] }

export const creditPlanSchema = z
  .object({ frequency: z.enum(["BIWEEKLY", "MONTHLY"]), installments: z.number().int().min(1).max(12) })
  .refine((p) => p.frequency === "BIWEEKLY" || p.installments <= 6, { message: "El plazo máximo es de 6 meses", path: ["installments"] })
export type CreditPlan = z.infer<typeof creditPlanSchema>
export const creditLimitSchema = z.object({ creditLimit: z.number().positive().max(1e12).nullable() })
export const customerPaymentSchema = z.object({
  customerId: z.uuid(),
  amount: z.number().positive().max(1e12),
  method: z.enum(["CASH", "CARD", "SINPE", "TRANSFER"]),
  reference: z.string().trim().max(60).optional(),
  tendered: z.number().positive().max(1e12).optional(),
  note: z.string().trim().max(200).optional(),
  inRegister: z.boolean(), // true = en la caja abierta de quien cobra
})
export const receivablesQuerySchema = z.object({ ...pageQuery, overdue: z.enum(["1", "0"]).optional() })

// Hoy como fecha sin hora (las cuotas vencen por día, en la hora local del servidor)
export const today = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
}
const DAY = 86_400_000

// Fechas de las cuotas: cada 15 días o el mismo día de cada mes (31 → último día del mes)
export function dueDates(plan: CreditPlan, start = today()) {
  return Array.from({ length: plan.installments }, (_, i) => {
    if (plan.frequency === "BIWEEKLY") return new Date(start.getTime() + 15 * (i + 1) * DAY)
    const y = start.getUTCFullYear()
    const m = start.getUTCMonth() + i + 1
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), last)))
  })
}

// Cuotas iguales; la última se lleva los centavos que sobran
export function buildInstallments(amount: Prisma.Decimal, plan: CreditPlan, start = today()) {
  const n = plan.installments
  const each = amount.div(n).toDecimalPlaces(2, D.ROUND_DOWN)
  return dueDates(plan, start).map((dueDate, i) => ({
    number: i + 1, frequency: plan.frequency, dueDate, amount: i === n - 1 ? amount.minus(each.times(n - 1)) : each,
  }))
}

// Saldo del cliente: cuotas pendientes (de la más vieja a la más nueva) y lo vencido
export async function creditStatus(customerId: string, db: Db = prisma) {
  const open = await db.installment.findMany({
    where: { customerId, paid: { lt: prisma.installment.fields.amount } },
    orderBy: [{ dueDate: "asc" }, { number: "asc" }],
  })
  const t = today()
  const owed = (rows: typeof open) => rows.reduce((s, r) => s.plus(r.amount).minus(r.paid), new D(0))
  const overdue = open.filter((r) => r.dueDate < t)
  return { open, balance: owed(open), overdue: owed(overdue), overdueCount: overdue.length }
}

// Bloquea la fila del cliente hasta el final de la transacción: dos ventas o abonos a la vez no se pisan el saldo
const lockCustomer = (db: Db, id: string) => db.$queryRaw`SELECT 1 FROM "Customer" WHERE id = ${id} FOR UPDATE`

// ---------- Venta a crédito (la llama pos.service.sell) ----------

// Antes de vender: cliente con crédito y sin cuotas vencidas
export async function assertCreditAllowed(customerId: string | undefined) {
  const customer = customerId ? await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } }) : null
  if (!customer) throw fail("La venta a crédito necesita un cliente", 400, "CREDIT_CUSTOMER")
  if (customer.creditLimit == null || !customer.idNumber) {
    throw fail(`${customer.name} no tiene crédito autorizado (lo habilita el administrador)`, 409, "CREDIT_CUSTOMER")
  }
  const status = await creditStatus(customer.id)
  if (status.overdueCount) {
    throw fail(`${customer.name} tiene ${status.overdueCount} cuota(s) vencida(s) por ${status.overdue.toFixed(2)}: no se le puede vender a crédito`, 409, "CREDIT_OVERDUE")
  }
  return customer
}

// Dentro de la transacción de la venta: revisa el límite con el saldo bloqueado y crea las cuotas
export async function createCreditInstallments(tx: Db, doc: { id: string; customerId: string; amount: Prisma.Decimal; plan: CreditPlan; limit: Prisma.Decimal }) {
  await lockCustomer(tx, doc.customerId)
  const { balance } = await creditStatus(doc.customerId, tx)
  const available = doc.limit.minus(balance)
  if (doc.amount.greaterThan(available)) {
    throw fail(`El crédito (${doc.amount.toFixed(2)}) pasa el límite del cliente: le quedan ${D.max(available, 0).toFixed(2)} disponibles`, 409, "CREDIT_LIMIT")
  }
  await tx.installment.createMany({
    data: buildInstallments(doc.amount, doc.plan).map((i) => ({ ...i, companyId: currentCompanyId(), customerId: doc.customerId, documentId: doc.id })),
  })
}

// ---------- Límite de crédito ----------

export async function setCreditLimit(customerId: string, input: z.infer<typeof creditLimitSchema>, userId: string) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } })
  if (!customer) throw fail("Cliente no encontrado", 404)
  if (input.creditLimit !== null && !(customer.idType && customer.idNumber)) {
    throw new Error("Para darle crédito, el cliente necesita su identificación")
  }
  const saved = await prisma.customer.update({ where: { id: customerId }, data: { creditLimit: input.creditLimit } })
  await logAudit(userId, "UPDATE", "Customer", customerId, { creditLimit: input.creditLimit })
  return saved
}

// ---------- Cuentas por cobrar ----------

// Clientes con crédito o con saldo pendiente, con su saldo y lo vencido
// ponytail: agrupa y pagina en memoria; pasar a SQL si alguna empresa llega a miles de clientes a crédito
export async function listReceivables(f: z.infer<typeof receivablesQuerySchema>) {
  const t = today()
  const pending = { paid: { lt: prisma.installment.fields.amount } }
  const [owed, late] = await Promise.all([
    prisma.installment.groupBy({ by: ["customerId"], where: pending, _sum: { amount: true, paid: true }, _min: { dueDate: true } }),
    prisma.installment.groupBy({ by: ["customerId"], where: { ...pending, dueDate: { lt: t } }, _sum: { amount: true, paid: true }, _count: true }),
  ])
  const sum = (g: { _sum: { amount: Prisma.Decimal | null; paid: Prisma.Decimal | null } }) => new D(g._sum.amount ?? 0).minus(g._sum.paid ?? 0)
  const owedBy = new Map(owed.map((g) => [g.customerId, { balance: sum(g), nextDue: g._min.dueDate }]))
  const lateBy = new Map(late.map((g) => [g.customerId, { overdue: sum(g), count: g._count }]))
  const customers = await prisma.customer.findMany({
    where: {
      OR: [{ creditLimit: { not: null }, deletedAt: null }, { id: { in: [...owedBy.keys()] } }],
      ...(f.q && { AND: [{ OR: [{ name: { contains: f.q, mode: "insensitive" } }, { idNumber: { startsWith: f.q.replace(/[\s-]/g, "") } }] }] }),
    },
    select: { id: true, name: true, idType: true, idNumber: true, phone: true, creditLimit: true },
  })
  const rows = customers
    .map((c) => {
      const o = owedBy.get(c.id)
      const l = lateBy.get(c.id)
      return {
        ...c,
        creditLimit: c.creditLimit?.toNumber() ?? null,
        balance: o?.balance.toNumber() ?? 0,
        overdue: l?.overdue.toNumber() ?? 0,
        overdueCount: l?.count ?? 0,
        nextDue: o?.nextDue ?? null,
      }
    })
    .filter((r) => f.overdue !== "1" || r.overdueCount > 0)
    .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance || a.name.localeCompare(b.name))
  const totals = { balance: rows.reduce((s, r) => s + r.balance, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0) }
  return { ...pageResult(rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize), rows.length, f), totals }
}

// Estado de cuenta de un cliente: saldo, disponible, cuotas y abonos
export async function getAccount(customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId },
    select: { id: true, name: true, idType: true, idNumber: true, phone: true, email: true, creditLimit: true, deletedAt: true },
  })
  if (!customer) throw fail("Cliente no encontrado", 404)
  const [status, installments, payments] = await Promise.all([
    creditStatus(customerId),
    prisma.installment.findMany({
      where: { customerId },
      orderBy: [{ dueDate: "desc" }, { number: "desc" }],
      take: 100,
      include: { document: { select: { id: true, consecutive: true, issuedAt: true, total: true } } },
    }),
    prisma.customerPayment.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { id: true, name: true } } },
    }),
  ])
  const limit = customer.creditLimit
  return {
    customer,
    creditLimit: limit?.toNumber() ?? null,
    balance: status.balance.toNumber(),
    available: limit ? D.max(limit.minus(status.balance), 0).toNumber() : 0,
    overdue: status.overdue.toNumber(),
    overdueCount: status.overdueCount,
    installments,
    payments,
  }
}

// ---------- Abonos ----------

export async function registerPayment(input: z.infer<typeof customerPaymentSchema>, actor: Actor) {
  let cashSessionId: string | null = null
  if (input.inRegister) {
    if (!actor.permissions.includes("sales.sell")) throw fail("No tienes permiso para cobrar en la caja", 403)
    if (input.method === "TRANSFER") throw new Error("En la caja el abono es en efectivo, tarjeta o SINPE")
    const session = await prisma.cashSession.findFirst({ where: { openedById: actor.id, status: "OPEN" }, select: { id: true } })
    if (!session) throw fail("No tienes una caja abierta", 409, "NO_SESSION")
    cashSessionId = session.id
  } else {
    if (!actor.permissions.includes("receivables.manage")) throw fail("No tienes permiso para registrar abonos fuera de la caja", 403)
    if (!input.reference) throw new Error("Fuera de la caja el abono necesita una referencia (n.º de transferencia, recibo…)")
  }
  if (input.tendered !== undefined && (input.method !== "CASH" || input.tendered < input.amount)) {
    throw new Error("Lo recibido en efectivo no puede ser menor que el abono")
  }
  const customer = await prisma.customer.findFirst({ where: { id: input.customerId }, select: { id: true, name: true } })
  if (!customer) throw fail("Cliente no encontrado", 404)

  const payment = await prisma.$transaction(async (tx) => {
    await lockCustomer(tx, customer.id)
    const { open, balance } = await creditStatus(customer.id, tx)
    if (!balance.greaterThan(0)) throw new Error(`${customer.name} no tiene saldo pendiente`)
    const amount = new D(input.amount)
    if (amount.greaterThan(balance)) throw new Error(`El abono supera el saldo (${balance.toFixed(2)})`)
    // a la cuota más vieja primero
    let left = amount
    for (const row of open) {
      if (!left.greaterThan(0)) break
      const apply = D.min(left, row.amount.minus(row.paid))
      await tx.installment.update({ where: { id: row.id }, data: { paid: row.paid.plus(apply) } })
      left = left.minus(apply)
    }
    const saved = await tx.customerPayment.create({
      data: {
        companyId: currentCompanyId(), customerId: customer.id, amount, method: input.method,
        reference: input.reference || null, tendered: input.tendered ?? null, note: input.note || null,
        balanceBefore: balance, balanceAfter: balance.minus(amount), cashSessionId, userId: actor.id,
      },
    })
    await logAudit(actor.id, "CREATE", "CustomerPayment", saved.id, { customer: customer.name, amount: input.amount, method: input.method }, tx)
    return saved
  })
  return getReceipt(payment.id)
}

// Recibo del abono: saldo anterior, abono y saldo nuevo
export async function getReceipt(id: string) {
  const payment = await prisma.customerPayment.findFirst({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, idType: true, idNumber: true } },
      user: { select: { id: true, name: true } },
      cashSession: { select: { register: { select: { name: true, ticketWidth: true, location: { select: { name: true } } } } } },
    },
  })
  if (!payment) throw fail("Abono no encontrado", 404)
  const c = await getCompany()
  return {
    payment,
    company: { name: c.name, legalName: c.legalName, idType: c.idType, idNumber: c.idNumber, phone: c.phone, addressDetail: c.addressDetail, currency: c.currency },
  }
}

// ---------- Aviso de cuotas vencidas ----------

// Una vez por cuota: avisa a quien tiene receivables.manage. Corre cada hora (server.ts) para todas las empresas.
export async function notifyOverdue() {
  const t = today()
  const due = await prismaRoot.installment.findMany({
    where: { dueDate: { lt: t }, notifiedAt: null, paid: { lt: prismaRoot.installment.fields.amount } },
    select: { id: true, companyId: true, customerId: true, amount: true, paid: true, customer: { select: { name: true } } },
  })
  const group = <T>(list: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>()
    for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x])
    return m
  }
  const byCompany = group(due, (i) => i.companyId)
  for (const [companyId, rows] of byCompany) {
    await runWithCompany(companyId, async () => {
      const ids = await memberIdsWith("receivables.manage")
      const byCustomer = group(rows, (r) => r.customerId)
      await prisma.$transaction(async (tx) => {
        await createNotifications(
          ids.flatMap((userId) =>
            [...byCustomer].map(([customerId, list]) => ({
              userId, type: "installmentOverdue", title: list[0]!.customer.name, link: `/receivables/${customerId}`,
              meta: { count: list.length, amount: list.reduce((s, r) => s.plus(r.amount).minus(r.paid), new D(0)).toNumber() },
            }))
          ),
          tx
        )
        await tx.installment.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { notifiedAt: new Date() } })
      })
    })
  }
  return due.length
}

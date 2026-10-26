// Bancos (Bloque 10, punto 53; decisiones del usuario del 25-oct-2026). Fase 53A:
//  - Cuentas de la empresa (colones o dólares). Cada cuenta dice de dónde recibe el SINPE y la tarjeta:
//    la empresa en general (Company.bankAccountId) y/o sucursales (Location.bankAccountId).
//  - Importar el estado del banco: el navegador lee el CSV/Excel y manda filas { date, reference,
//    description, amount con signo }. Importar dos veces el mismo rango no duplica (único en la tabla).
//  - Lo que no tiene pareja en el sistema se clasifica (comisión, intereses, retiro del dueño…).
//  - Depósitos del efectivo de las cajas. La conciliación sugerida llega en la fase 53B.
import { z } from "zod"
import { prisma, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { logAudit } from "../audit/audit.service.ts"

const fail = (message: string, status: number) => Object.assign(new Error(message), { status })
const dateOnly = (d: string) => new Date(`${d}T00:00:00Z`)

export const CATEGORIES = ["BANK_FEE", "INTEREST", "OWNER_WITHDRAWAL", "OWNER_CONTRIBUTION", "EXPENSE", "OTHER_INCOME", "OTHER"] as const

export const bankAccountSchema = z.object({
  name: z.string().trim().min(1, "Indica un nombre").max(60),
  bankName: z.string().trim().min(1, "Indica el banco").max(60),
  number: z.string().trim().max(34).optional(), // IBAN
  currency: z.enum(["CRC", "USD"]),
  isActive: z.boolean().optional(),
  // de dónde recibe el SINPE y la tarjeta
  general: z.boolean().default(false),
  locationIds: z.array(z.uuid()).default([]),
})
export const importSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  rows: z
    .array(z.object({
      date: z.iso.date(),
      reference: z.string().trim().max(60).default(""),
      description: z.string().trim().min(1, "Hay una fila sin descripción").max(300),
      amount: z.number().refine((n) => n !== 0 && Math.abs(n) < 1e12, "Hay una fila sin monto"),
    }))
    .min(1, "El archivo no tiene movimientos")
    .max(5000, "Máximo 5000 movimientos por archivo"),
})
export const transactionsQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["pending", "reviewed", "all"]).default("pending"),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
})
export const classifySchema = z.object({
  category: z.enum(CATEGORIES).nullable(),
  note: z.string().trim().max(200).optional(),
})
export const depositSchema = z.object({
  bankAccountId: z.uuid(),
  locationId: z.uuid().optional(),
  amount: z.number().positive().max(1e12),
  depositedAt: z.iso.date(),
  reference: z.string().trim().min(1, "Indica el n.º de comprobante del depósito").max(60),
  note: z.string().trim().max(200).optional(),
})
export const depositsQuerySchema = z.object({ ...pageQuery, bankAccountId: z.uuid().optional() })

// Cuenta activa de la empresa (para ligar pagos y depósitos)
export async function activeAccount(id: string, db: Db = prisma) {
  const account = await db.bankAccount.findFirst({ where: { id, isActive: true }, select: { id: true } })
  if (!account) throw fail("Cuenta bancaria no encontrada o inactiva", 404)
  return account
}

// ---------- Cuentas ----------

export async function listAccounts() {
  const [accounts, company, pending] = await Promise.all([
    prisma.bankAccount.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: { locations: { select: { id: true, name: true } } },
    }),
    prisma.company.findUniqueOrThrow({ where: { id: currentCompanyId() }, select: { bankAccountId: true } }),
    prisma.bankTransaction.groupBy({ by: ["bankAccountId"], where: { reviewedAt: null }, _count: true }),
  ])
  const pendingBy = new Map(pending.map((p) => [p.bankAccountId, p._count]))
  return accounts.map((a) => ({ ...a, general: company.bankAccountId === a.id, pending: pendingBy.get(a.id) ?? 0 }))
}

// La cuenta recibe el SINPE/tarjeta de la empresa (general) y de las sucursales marcadas;
// las sucursales que la tenían y ya no están marcadas vuelven a la cuenta de la empresa.
async function route(tx: Db, id: string, input: z.infer<typeof bankAccountSchema>) {
  const companyId = currentCompanyId()
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { bankAccountId: true } })
  if (input.general) await tx.company.update({ where: { id: companyId }, data: { bankAccountId: id } })
  else if (company.bankAccountId === id) await tx.company.update({ where: { id: companyId }, data: { bankAccountId: null } })
  await tx.location.updateMany({ where: { bankAccountId: id, id: { notIn: input.locationIds } }, data: { bankAccountId: null } })
  if (input.locationIds.length) {
    const { count } = await tx.location.updateMany({ where: { id: { in: input.locationIds }, type: "BRANCH" }, data: { bankAccountId: id } })
    if (count !== input.locationIds.length) throw new Error("Alguna sucursal no es de esta empresa")
  }
}

const accountData = (input: z.infer<typeof bankAccountSchema>) => ({
  name: input.name, bankName: input.bankName, number: input.number?.replace(/\s/g, "").toUpperCase() || null, currency: input.currency,
})

export async function createAccount(input: z.infer<typeof bankAccountSchema>, userId: string) {
  const account = await prisma.$transaction(async (tx) => {
    const saved = await tx.bankAccount.create({ data: { companyId: currentCompanyId(), ...accountData(input) } })
    await route(tx, saved.id, input)
    await logAudit(userId, "CREATE", "BankAccount", saved.id, { name: input.name, bank: input.bankName, currency: input.currency }, tx)
    return saved
  })
  return account
}

export async function updateAccount(id: string, input: z.infer<typeof bankAccountSchema>, userId: string) {
  const current = await prisma.bankAccount.findFirst({ where: { id } })
  if (!current) throw fail("Cuenta bancaria no encontrada", 404)
  if (current.currency !== input.currency && (await prisma.bankTransaction.count({ where: { bankAccountId: id } }))) {
    throw new Error("La cuenta ya tiene movimientos: no se le puede cambiar la moneda")
  }
  const isActive = input.isActive ?? current.isActive
  return prisma.$transaction(async (tx) => {
    const saved = await tx.bankAccount.update({ where: { id }, data: { ...accountData(input), isActive } })
    // una cuenta inactiva no recibe nada
    await route(tx, id, isActive ? input : { ...input, general: false, locationIds: [] })
    await logAudit(userId, "UPDATE", "BankAccount", id, { name: input.name, isActive }, tx)
    return saved
  })
}

// ---------- Estado bancario ----------

export async function importStatement(accountId: string, input: z.infer<typeof importSchema>, userId: string) {
  await activeAccount(accountId)
  const dates = input.rows.map((r) => r.date).sort()
  return prisma.$transaction(async (tx) => {
    const imp = await tx.bankImport.create({
      data: {
        companyId: currentCompanyId(), bankAccountId: accountId, fileName: input.fileName, rows: input.rows.length,
        inserted: 0, duplicates: 0, dateFrom: dateOnly(dates[0]!), dateTo: dateOnly(dates.at(-1)!), userId,
      },
    })
    const { count } = await tx.bankTransaction.createMany({
      data: input.rows.map((r) => ({
        companyId: currentCompanyId(), bankAccountId: accountId, importId: imp.id, date: dateOnly(r.date),
        reference: r.reference, description: r.description, amount: new Prisma.Decimal(r.amount).toDecimalPlaces(2),
      })),
      skipDuplicates: true, // ya importados antes (o repetidos en el mismo archivo)
    })
    const saved = await tx.bankImport.update({ where: { id: imp.id }, data: { inserted: count, duplicates: input.rows.length - count } })
    await logAudit(userId, "CREATE", "BankImport", imp.id, { fileName: input.fileName, inserted: count }, tx)
    return saved
  })
}

export async function listTransactions(accountId: string, f: z.infer<typeof transactionsQuerySchema>) {
  const where: Prisma.BankTransactionWhereInput = {
    bankAccountId: accountId,
    ...(f.status === "pending" && { reviewedAt: null }),
    ...(f.status === "reviewed" && { reviewedAt: { not: null } }),
    ...((f.from || f.to) && { date: { ...(f.from && { gte: dateOnly(f.from) }), ...(f.to && { lte: dateOnly(f.to) }) } }),
    ...(f.q && { OR: [{ description: { contains: f.q, mode: "insensitive" } }, { reference: { startsWith: f.q } }] }),
  }
  const [total, items, sums] = await Promise.all([
    prisma.bankTransaction.count({ where }),
    prisma.bankTransaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: { reviewedBy: { select: { id: true, name: true } }, matches: { select: { sourceType: true, sourceId: true, amount: true, label: true } } },
      ...pageArgs(f),
    }),
    Promise.all([
      prisma.bankTransaction.aggregate({ where: { ...where, amount: { gt: 0 } }, _sum: { amount: true } }),
      prisma.bankTransaction.aggregate({ where: { ...where, amount: { lt: 0 } }, _sum: { amount: true } }),
    ]),
  ])
  const [credits, debits] = sums.map((s) => s._sum.amount?.toNumber() ?? 0)
  return { ...pageResult(items, total, f), totals: { credits, debits: Math.abs(debits!) } }
}

// Clasificar (o quitar la clasificación) un movimiento sin pareja en el sistema
export async function classifyTransaction(id: string, input: z.infer<typeof classifySchema>, userId: string) {
  const t = await prisma.bankTransaction.findFirst({ where: { id }, include: { _count: { select: { matches: true } } } })
  if (!t) throw fail("Movimiento no encontrado", 404)
  if (t._count.matches) throw new Error("El movimiento está conciliado: deshacé la conciliación antes de clasificarlo")
  const reviewed = input.category !== null
  const saved = await prisma.bankTransaction.update({
    where: { id },
    data: {
      category: input.category,
      note: input.note || null,
      reviewedById: reviewed ? userId : null,
      reviewedAt: reviewed ? new Date() : null,
    },
  })
  await logAudit(userId, "UPDATE", "BankTransaction", id, { category: input.category, note: input.note })
  return saved
}

// ---------- Depósitos de efectivo ----------

export async function createDeposit(input: z.infer<typeof depositSchema>, userId: string) {
  await activeAccount(input.bankAccountId)
  if (input.locationId && !(await prisma.location.findFirst({ where: { id: input.locationId }, select: { id: true } }))) {
    throw fail("Sucursal no encontrada", 404)
  }
  const saved = await prisma.cashDeposit.create({
    data: {
      companyId: currentCompanyId(), bankAccountId: input.bankAccountId, locationId: input.locationId ?? null,
      amount: input.amount, depositedAt: dateOnly(input.depositedAt), reference: input.reference, note: input.note || null, userId,
    },
  })
  await logAudit(userId, "CREATE", "CashDeposit", saved.id, { amount: input.amount, reference: input.reference })
  return saved
}

export async function listDeposits(f: z.infer<typeof depositsQuerySchema>) {
  const where: Prisma.CashDepositWhereInput = {
    ...(f.bankAccountId && { bankAccountId: f.bankAccountId }),
    ...(f.q && { reference: { startsWith: f.q } }),
  }
  const [total, items] = await Promise.all([
    prisma.cashDeposit.count({ where }),
    prisma.cashDeposit.findMany({
      where,
      orderBy: [{ depositedAt: "desc" }, { createdAt: "desc" }],
      include: { bankAccount: { select: { id: true, name: true } }, location: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
      ...pageArgs(f),
    }),
  ])
  return pageResult(items, total, f)
}

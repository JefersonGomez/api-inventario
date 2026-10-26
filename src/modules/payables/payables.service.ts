// Cuentas por pagar (Bloque 10, punto 52; decisiones del usuario del 25-oct-2026):
//  - La factura del proveedor se registra al recibir una orden (prellenada con lo recibido) o suelta
//    (fletes, servicios). El XML llega con la facturación electrónica (Bloque 9).
//  - Vencimiento = fecha de la factura + días de crédito del proveedor (0 = contado), editable.
//  - Pagos con método y referencia, sin tocar la caja; un pago cubre varias facturas, de la que vence
//    primero a la última (o solo las elegidas). Se ligan a la cuenta bancaria en el punto 53.
//  - Lo maneja quien tiene payables.manage (ADMIN, MANAGER y ACCOUNTANT).
//  - Aviso en la campanita cuando una factura vence en 3 días o menos (una vez por factura).
import { z } from "zod"
import { prisma, prismaRoot, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, runWithCompany } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { logAudit } from "../audit/audit.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"
import { today } from "../receivables/receivables.service.ts"

const D = Prisma.Decimal
const DAY = 86_400_000
const fail = (message: string, status: number) => Object.assign(new Error(message), { status })
const money = z.number().min(0).max(1e12)

// Lo que trae la factura en papel. Al recibir una orden, subtotal e IVA salen de lo recibido si no vienen.
export const receiveInvoiceSchema = z.object({
  number: z.string().trim().min(1, "Indica el número de la factura").max(50),
  issueDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  subtotal: money.optional(),
  tax: money.optional(),
  note: z.string().trim().max(200).optional(),
})
export type ReceiveInvoice = z.infer<typeof receiveInvoiceSchema>
export const invoiceSchema = receiveInvoiceSchema.extend({
  supplierId: z.uuid(),
  purchaseOrderId: z.uuid().optional(),
  subtotal: money,
  tax: money,
})
export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(1, "Indica el motivo").max(200) })
export const supplierPaymentSchema = z.object({
  supplierId: z.uuid(),
  amount: z.number().positive().max(1e12),
  method: z.enum(["CASH", "CARD", "SINPE", "TRANSFER", "OTHER"]),
  reference: z.string().trim().max(60).optional(),
  paidAt: z.iso.date().optional(),
  note: z.string().trim().max(200).optional(),
  invoiceIds: z.array(z.uuid()).min(1).optional(), // sin esto: de la que vence primero
})
export const payablesQuerySchema = z.object({ ...pageQuery, overdue: z.enum(["1", "0"]).optional() })
export const invoicesQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["open", "overdue", "paid", "void"]).default("open"),
  supplierId: z.uuid().optional(),
})

const dateOnly = (d: string) => new Date(`${d}T00:00:00Z`)
const openWhere = { voidedAt: null, paid: { lt: prisma.supplierInvoice.fields.total } }
const owed = (i: { total: Prisma.Decimal; paid: Prisma.Decimal }) => i.total.minus(i.paid)

// Bloquea al proveedor hasta el final de la transacción: dos pagos a la vez no se pisan el saldo
const lockSupplier = (db: Db, id: string) => db.$queryRaw`SELECT 1 FROM "Supplier" WHERE id = ${id} FOR UPDATE`

// ---------- Facturas ----------

type NewInvoice = z.infer<typeof receiveInvoiceSchema> & { supplierId: string; purchaseOrderId?: string | undefined; subtotal: number; tax: number }

// La usa también la recepción de órdenes, dentro de su transacción
export async function createInvoice(tx: Db, input: NewInvoice, userId: string) {
  const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { id: true, name: true, creditDays: true } })
  if (!supplier) throw fail("Proveedor no encontrado", 404)
  const issueDate = dateOnly(input.issueDate)
  const dueDate = input.dueDate ? dateOnly(input.dueDate) : new Date(issueDate.getTime() + supplier.creditDays * DAY)
  if (dueDate < issueDate) throw new Error("El vencimiento no puede ser antes de la fecha de la factura")
  const subtotal = new D(input.subtotal).toDecimalPlaces(2)
  const tax = new D(input.tax).toDecimalPlaces(2)
  const total = subtotal.plus(tax)
  if (!total.greaterThan(0)) throw new Error("La factura tiene que tener un monto")
  const dup = await tx.supplierInvoice.findFirst({ where: { supplierId: supplier.id, number: input.number, voidedAt: null }, select: { id: true } })
  if (dup) throw new Error(`La factura ${input.number} de ${supplier.name} ya está registrada`)

  const invoice = await tx.supplierInvoice.create({
    data: {
      companyId: currentCompanyId(), supplierId: supplier.id, purchaseOrderId: input.purchaseOrderId ?? null,
      number: input.number, issueDate, dueDate, subtotal, tax, total, note: input.note || null, createdById: userId,
    },
  })
  await logAudit(userId, "CREATE", "SupplierInvoice", invoice.id, { supplier: supplier.name, number: input.number, total: total.toNumber() }, tx)
  return invoice
}

// Factura suelta (o de una orden ya recibida)
export async function registerInvoice(input: z.infer<typeof invoiceSchema>, userId: string) {
  if (input.purchaseOrderId) {
    const order = await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId }, select: { supplierId: true } })
    if (!order) throw fail("Orden de compra no encontrada", 404)
    if (order.supplierId !== input.supplierId) throw new Error("La orden es de otro proveedor")
  }
  return prisma.$transaction((tx) => createInvoice(tx, input, userId))
}

// Anular una factura mal registrada: solo si no tiene pagos
export async function voidInvoice(id: string, reason: string, userId: string) {
  const invoice = await prisma.supplierInvoice.findFirst({ where: { id } })
  if (!invoice) throw fail("Factura no encontrada", 404)
  if (invoice.voidedAt) throw new Error("La factura ya está anulada")
  if (invoice.paid.greaterThan(0)) throw new Error("La factura tiene pagos: no se puede anular")
  const saved = await prisma.supplierInvoice.update({ where: { id }, data: { voidedAt: new Date(), voidReason: reason } })
  await logAudit(userId, "UPDATE", "SupplierInvoice", id, { voided: true, number: invoice.number, reason })
  return saved
}

export async function listInvoices(f: z.infer<typeof invoicesQuerySchema>) {
  const t = today()
  const where: Prisma.SupplierInvoiceWhereInput = {
    ...(f.supplierId && { supplierId: f.supplierId }),
    ...(f.status === "open" && openWhere),
    ...(f.status === "overdue" && { ...openWhere, dueDate: { lt: t } }),
    ...(f.status === "paid" && { voidedAt: null, paid: { equals: prisma.supplierInvoice.fields.total } }),
    ...(f.status === "void" && { voidedAt: { not: null } }),
    ...(f.q && { OR: [{ number: { contains: f.q, mode: "insensitive" } }, { supplier: { name: { contains: f.q, mode: "insensitive" } } }] }),
  }
  const [total, items] = await Promise.all([
    prisma.supplierInvoice.count({ where }),
    prisma.supplierInvoice.findMany({
      where,
      include: { supplier: { select: { id: true, name: true } } },
      orderBy: f.status === "open" || f.status === "overdue" ? [{ dueDate: "asc" }, { createdAt: "asc" }] : { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ])
  return pageResult(items, total, f)
}

// ---------- Saldos por proveedor ----------

// Antigüedad de lo vencido: al día, 1–30, 31–60, 61–90 y más de 90 días
const BUCKETS = ["current", "d30", "d60", "d90", "over90"] as const
const bucketOf = (dueDate: Date, t: Date) => {
  const late = Math.floor((t.getTime() - dueDate.getTime()) / DAY)
  return late <= 0 ? "current" : late <= 30 ? "d30" : late <= 60 ? "d60" : late <= 90 ? "d90" : "over90"
}
const emptyAging = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<(typeof BUCKETS)[number], number>

// ponytail: trae las facturas abiertas y agrupa en memoria; pasar a SQL si alguna empresa llega a miles abiertas
export async function listPayables(f: z.infer<typeof payablesQuerySchema>) {
  const t = today()
  const open = await prisma.supplierInvoice.findMany({
    where: {
      ...openWhere,
      ...(f.q && { supplier: { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { idNumber: { startsWith: f.q.replace(/[\s-]/g, "") } }] } }),
    },
    select: { supplierId: true, total: true, paid: true, dueDate: true, supplier: { select: { id: true, name: true, creditDays: true, phone: true } } },
  })
  const bySupplier = new Map<string, { supplier: (typeof open)[number]["supplier"]; balance: number; overdue: number; invoices: number; nextDue: Date; aging: ReturnType<typeof emptyAging> }>()
  const totals = { balance: 0, overdue: 0, aging: emptyAging() }
  for (const inv of open) {
    const amount = owed(inv).toNumber()
    const row = bySupplier.get(inv.supplierId) ?? { supplier: inv.supplier, balance: 0, overdue: 0, invoices: 0, nextDue: inv.dueDate, aging: emptyAging() }
    const bucket = bucketOf(inv.dueDate, t)
    row.balance += amount
    row.invoices++
    row.aging[bucket] += amount
    totals.aging[bucket] += amount
    if (bucket !== "current") row.overdue += amount
    if (inv.dueDate < row.nextDue) row.nextDue = inv.dueDate
    bySupplier.set(inv.supplierId, row)
  }
  const rows = [...bySupplier.values()]
    .filter((r) => f.overdue !== "1" || r.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue || a.nextDue.getTime() - b.nextDue.getTime() || a.supplier.name.localeCompare(b.supplier.name))
  for (const r of rows) {
    totals.balance += r.balance
    totals.overdue += r.overdue
  }
  return { ...pageResult(rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize), rows.length, f), totals }
}

// Estado de cuenta con un proveedor: saldo, vencido, facturas y pagos
export async function getSupplierAccount(supplierId: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId },
    select: { id: true, name: true, idType: true, idNumber: true, email: true, phone: true, creditDays: true },
  })
  if (!supplier) throw fail("Proveedor no encontrado", 404)
  const t = today()
  const [invoices, payments] = await Promise.all([
    prisma.supplierInvoice.findMany({ where: { supplierId }, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], take: 100 }),
    prisma.supplierPayment.findMany({
      where: { supplierId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { id: true, name: true } }, allocations: { select: { amount: true, invoice: { select: { id: true, number: true } } } } },
    }),
  ])
  const open = invoices.filter((i) => !i.voidedAt && i.paid.lessThan(i.total))
  const sum = (list: typeof open) => list.reduce((s, i) => s.plus(owed(i)), new D(0)).toNumber()
  return { supplier, balance: sum(open), overdue: sum(open.filter((i) => i.dueDate < t)), invoices, payments }
}

// ---------- Pagos ----------

export async function registerSupplierPayment(input: z.infer<typeof supplierPaymentSchema>, userId: string) {
  if (input.method !== "CASH" && !input.reference) throw new Error("El pago necesita una referencia (n.º de transferencia, cheque…)")
  const supplier = await prisma.supplier.findFirst({ where: { id: input.supplierId }, select: { id: true, name: true } })
  if (!supplier) throw fail("Proveedor no encontrado", 404)

  const payment = await prisma.$transaction(async (tx) => {
    await lockSupplier(tx, supplier.id)
    const open = await tx.supplierInvoice.findMany({
      where: { supplierId: supplier.id, ...openWhere, ...(input.invoiceIds && { id: { in: input.invoiceIds } }) },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    })
    if (input.invoiceIds && open.length !== input.invoiceIds.length) throw new Error("Alguna factura no es de este proveedor, está pagada o anulada")
    const balance = open.reduce((s, i) => s.plus(owed(i)), new D(0))
    if (!balance.greaterThan(0)) throw new Error(`No hay saldo pendiente con ${supplier.name}`)
    const amount = new D(input.amount)
    if (amount.greaterThan(balance)) throw new Error(`El pago supera el saldo (${balance.toFixed(2)})`)

    const saved = await tx.supplierPayment.create({
      data: {
        companyId: currentCompanyId(), supplierId: supplier.id, amount, method: input.method, reference: input.reference || null,
        paidAt: input.paidAt ? dateOnly(input.paidAt) : today(), note: input.note || null, userId,
      },
    })
    let left = amount
    for (const inv of open) {
      if (!left.greaterThan(0)) break
      const apply = D.min(left, owed(inv))
      await tx.supplierInvoice.update({ where: { id: inv.id }, data: { paid: inv.paid.plus(apply) } })
      await tx.supplierPaymentAllocation.create({ data: { paymentId: saved.id, invoiceId: inv.id, amount: apply } })
      left = left.minus(apply)
    }
    await logAudit(userId, "CREATE", "SupplierPayment", saved.id, { supplier: supplier.name, amount: input.amount, method: input.method }, tx)
    return saved
  })
  return prisma.supplierPayment.findUniqueOrThrow({
    where: { id: payment.id },
    include: { allocations: { select: { amount: true, invoice: { select: { id: true, number: true } } } } },
  })
}

// ---------- Aviso de facturas por vencer ----------

// Una vez por factura, cuando vence en 3 días o menos (o ya venció sin aviso). Corre cada hora (server.ts).
export async function notifyPayablesDue() {
  const limit = new Date(today().getTime() + 3 * DAY)
  const due = await prismaRoot.supplierInvoice.findMany({
    where: { dueDate: { lte: limit }, notifiedAt: null, voidedAt: null, paid: { lt: prismaRoot.supplierInvoice.fields.total } },
    select: { id: true, companyId: true, supplierId: true, total: true, paid: true, dueDate: true, supplier: { select: { name: true } } },
  })
  const group = <T>(list: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>()
    for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x])
    return m
  }
  const byCompany = group(due, (i) => i.companyId)
  for (const [companyId, rows] of byCompany) {
    await runWithCompany(companyId, async () => {
      const ids = await memberIdsWith("payables.manage")
      const bySupplier = group(rows, (r) => r.supplierId)
      await prisma.$transaction(async (tx) => {
        await createNotifications(
          ids.flatMap((userId) =>
            [...bySupplier].map(([supplierId, list]) => ({
              userId, type: "payableDue", title: list[0]!.supplier.name, link: `/payables/${supplierId}`,
              meta: {
                count: list.length,
                amount: list.reduce((s, r) => s.plus(owed(r)), new D(0)).toNumber(),
                dueDate: list.reduce((min, r) => (r.dueDate < min ? r.dueDate : min), list[0]!.dueDate),
              },
            }))
          ),
          tx
        )
        await tx.supplierInvoice.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { notifiedAt: new Date() } })
      })
    })
  }
  return due.length
}

// Ventas y devoluciones (Bloque 7C, decisiones del usuario del 20-oct-2026):
//  - Lista de comprobantes de venta y notas de crédito con filtros; detalle con el tiquete para reimprimir.
//  - Devolución (total = anular, o parcial) con nota de crédito que referencia la venta; nunca más de lo
//    vendido contando las devoluciones anteriores; dentro del plazo de la empresa (Company.returnDays).
//  - SIEMPRE con el código del encargado (sales.void).
//  - Por producto: en buen estado vuelve al stock (RETURN); dañado no vuelve y avisa a inventario (merma).
//  - Dinero: venta a crédito → primero rebaja sus cuotas (desde la última); lo que sobra, y en las de
//    contado todo, se reembolsa por el medio que elige el cajero (el efectivo sale de su caja abierta).
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, locationScope } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { TAX_PERCENT } from "../../shared/fiscal.ts"
import { getCompany } from "../company/company.service.ts"
import { issueDocument, type DocumentLineInput } from "../documents/document.service.ts"
import { createMovement } from "../movements/movements.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"
import { authorizeWithPin } from "../users/pin.service.ts"
import { getTicket } from "../pos/pos.service.ts"
import { creditReturn } from "../receivables/receivables.service.ts"

const D = Prisma.Decimal
const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
type Actor = { id: string; permissions: string[] }
const SALE_TYPES = ["TICKET", "INVOICE"] as const

export const salesQuerySchema = z.object({
  ...pageQuery,
  kind: z.enum(["SALE", "CREDIT_NOTE"]).optional(), // sin indicar: ventas y notas
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  registerId: z.uuid().optional(),
  customerId: z.uuid().optional(),
})
export const returnSchema = z.object({
  lines: z
    .array(z.object({ lineId: z.uuid(), quantity: z.number().positive().max(1e9), condition: z.enum(["GOOD", "DAMAGED"]) }))
    .min(1)
    .max(1000)
    .refine((l) => new Set(l.map((x) => x.lineId)).size === l.length, "Una línea aparece dos veces"),
  reason: z.string().trim().min(3, "Indica el motivo").max(200),
  // cómo se le devuelve el dinero (no hace falta si todo se rebaja del crédito)
  refund: z.object({ method: z.enum(["CASH", "CARD", "SINPE", "TRANSFER"]), reference: z.string().trim().max(60).optional() }).optional(),
  pin: z.string().regex(/^\d{4,6}$/, "El código tiene de 4 a 6 dígitos"),
})

// ---------- Lista y detalle ----------

const dayStart = (d: string) => new Date(`${d}T00:00:00`)
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`)

export async function listSales(f: z.infer<typeof salesQuerySchema>) {
  const scope = locationScope()
  const q = f.q?.trim()
  const where: Prisma.DocumentWhereInput = {
    type: f.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : f.kind === "SALE" ? { in: [...SALE_TYPES] } : { in: [...SALE_TYPES, "CREDIT_NOTE"] },
    ...((f.from || f.to) && { issuedAt: { ...(f.from && { gte: dayStart(f.from) }), ...(f.to && { lte: dayEnd(f.to) }) } }),
    ...(f.customerId && { customerId: f.customerId }),
    ...(f.registerId && { cashSession: { registerId: f.registerId } }),
    ...(scope && { cashSession: { ...(f.registerId && { registerId: f.registerId }), register: { locationId: { in: scope } } } }),
    // el número se busca por el final (lo que se ve en el tiquete) o por el cliente
    ...(q && { OR: [{ consecutive: { endsWith: q.replace(/\D/g, "") || q } }, { customer: { name: { contains: q, mode: "insensitive" } } }] }),
  }
  const [items, total] = await Promise.all([
    prisma.document.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      ...pageArgs(f),
      select: {
        id: true, type: true, consecutive: true, issuedAt: true, total: true, saleCondition: true,
        customer: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        cashSession: { select: { register: { select: { name: true, location: { select: { name: true } } } } } },
        referenceDocument: { select: { id: true, consecutive: true } },
        _count: { select: { referencedBy: true } },
      },
    }),
    prisma.document.count({ where }),
  ])
  return pageResult(items, total, f)
}

// Lo ya devuelto de cada línea de una venta
async function returnedByLine(documentId: string) {
  const rows = await prisma.documentLine.groupBy({
    by: ["sourceLineId"],
    where: { sourceLine: { documentId } },
    _sum: { quantity: true },
  })
  return new Map(rows.map((r) => [r.sourceLineId!, r._sum.quantity ?? new D(0)]))
}

// Venta (o nota) con su tiquete, lo devuelto por línea, sus notas de crédito y hasta cuándo se puede devolver
export async function getSale(id: string) {
  const exists = await prisma.document.findFirst({ where: { id, type: { in: [...SALE_TYPES, "CREDIT_NOTE"] } }, select: { id: true, type: true, issuedAt: true } })
  if (!exists) throw fail("Venta no encontrada", 404)
  const ticket = await getTicket(id)
  if (exists.type === "CREDIT_NOTE") return { ...ticket, returned: {}, creditNotes: [], returnUntil: null }
  const [returned, notes, company] = await Promise.all([
    returnedByLine(id),
    prisma.document.findMany({
      where: { referenceDocumentId: id, type: "CREDIT_NOTE" },
      orderBy: { issuedAt: "asc" },
      select: { id: true, consecutive: true, issuedAt: true, total: true, referenceReason: true, returnAuthorizedBy: { select: { name: true } }, payments: true },
    }),
    getCompany(),
  ])
  return {
    ...ticket,
    returned: Object.fromEntries([...returned].map(([k, v]) => [k, v.toNumber()])),
    creditNotes: notes,
    returnUntil: new Date(exists.issuedAt.getTime() + company.returnDays * 86_400_000),
  }
}

// ---------- Devolución ----------

export async function createReturn(id: string, input: z.infer<typeof returnSchema>, actor: Actor) {
  const doc = await prisma.document.findFirst({
    where: { id, type: { in: [...SALE_TYPES] } },
    include: { lines: true, payments: true, cashSession: { select: { register: { select: { locationId: true, location: { select: { name: true } } } } } } },
  })
  if (!doc) throw fail("Venta no encontrada", 404)
  if (doc.cashSession) assertLocationAllowed(doc.cashSession.register.locationId)
  const company = await getCompany()
  const until = new Date(doc.issuedAt.getTime() + company.returnDays * 86_400_000)
  if (new Date() > until) {
    throw fail(`El plazo para devolver esta venta venció el ${until.toLocaleDateString("es-CR")} (${company.returnDays} días)`, 409, "RETURN_EXPIRED")
  }

  // cantidades: nunca más de lo vendido menos lo ya devuelto
  const byId = new Map(doc.lines.map((l) => [l.id, l]))
  const returned = await returnedByLine(doc.id)
  const picked = input.lines.map((r) => {
    const line = byId.get(r.lineId)
    if (!line) throw new Error("Esa línea no es de esta venta")
    const left = line.quantity.minus(returned.get(line.id) ?? 0)
    if (new D(r.quantity).greaterThan(left)) throw new Error(`${line.description}: solo quedan ${left.toNumber()} por devolver`)
    return { ...r, line }
  })

  // la caja abierta de quien devuelve (el efectivo sale de ahí); sin caja no se devuelve efectivo
  const session = await prisma.cashSession.findFirst({
    where: { openedById: actor.id, status: "OPEN" },
    select: { id: true, register: { select: { terminalCode: true, locationId: true, location: { select: { name: true, code: true } } } } },
  })
  if (input.refund?.method === "CASH" && !session) throw fail("Para devolver efectivo necesitas tu caja abierta", 409, "NO_SESSION")

  const described = picked.map((p) => `${p.quantity} × ${p.line.description}`).join(", ")
  const auth = await authorizeWithPin(actor.id, input.pin, "sales.void", `Devolución de ${doc.consecutive}: ${described}`.slice(0, 200))
  if (!auth) throw fail("Ese código no autoriza devoluciones (tiene que ser de un encargado, vigente)", 403, "RETURN_PIN")

  // líneas de la nota: mismo precio y la parte proporcional del descuento de la venta (montos con IVA)
  const lines: DocumentLineInput[] = picked.map(({ line, quantity, condition }) => {
    const factor = 1 + TAX_PERCENT[line.taxRate] / 100
    const share = new D(quantity).div(line.quantity)
    return {
      ...(line.productId && { productId: line.productId }),
      quantity,
      description: line.description,
      unitPriceWithTax: line.unitPrice.times(factor).toNumber(),
      ...(line.discount.greaterThan(0) && {
        discountWithTax: line.discount.times(factor).times(share).toDecimalPlaces(5).toNumber(),
        ...(line.discountLabel && { discountLabel: line.discountLabel }),
      }),
      unit: line.unit,
      taxRate: line.taxRate,
      cabys: line.cabys,
      sourceLineId: line.id,
      returnCondition: condition,
    }
  })
  const locationId = session?.register.locationId ?? doc.cashSession?.register.locationId

  const result = await prisma.$transaction(async (tx) => {
    const note = await issueDocument(
      {
        type: "CREDIT_NOTE",
        customerId: doc.customerId,
        lines,
        referenceDocumentId: doc.id,
        referenceReason: input.reason,
        branchCode: session?.register.location.code ?? doc.branchCode,
        terminalCode: session?.register.terminalCode ?? doc.terminalCode,
        ...(session && { cashSessionId: session.id }),
        returnAuthorizedById: auth.authorizedBy.id,
      },
      actor.id,
      tx
    )
    const total = new D(note.total).toDecimalPlaces(2)
    // a crédito: primero baja lo que debe de esta venta
    const credited = doc.saleCondition === "CREDIT" && doc.customerId ? await creditReturn(tx, { id: doc.id, customerId: doc.customerId }, total) : new D(0)
    const refund = total.minus(credited)
    if (refund.greaterThan(0)) {
      if (!input.refund) throw new Error(`Indica cómo se le devuelven ${refund.toFixed(2)} al cliente`)
      // los pagos de la nota = lo reembolsado (se agregan después: lo rebajado del crédito no es un pago)
      await tx.documentPayment.create({
        data: { documentId: note.id, method: input.refund.method, amount: refund, reference: input.refund.reference || null },
      })
    }
    // stock: lo que volvió en buen estado entra a la sucursal donde se devuelve
    for (const p of picked) {
      if (p.condition !== "GOOD" || !p.line.productId) continue
      await createMovement(p.line.productId, actor.id, "IN", p.quantity, `Devolución ${note.consecutive}`, tx, {
        source: "RETURN", sourceId: note.id, ...(locationId && { locationId }), lotDefault: "DEVOLUCION",
      })
    }
    // lo dañado no vuelve: aviso a quien maneja el inventario (merma)
    const damaged = picked.filter((p) => p.condition === "DAMAGED")
    if (damaged.length) {
      const ids = await memberIdsWith("stock.move", locationId ?? undefined)
      await createNotifications(
        ids.flatMap((userId) =>
          damaged.map((p) => ({
            userId, type: "returnDamaged", title: p.line.description, link: `/sales/${doc.id}`,
            meta: { quantity: p.quantity, unit: p.line.unit, consecutive: note.consecutive, reason: input.reason },
          }))
        ),
        tx
      )
    }
    return { noteId: note.id, credited: credited.toNumber(), refund: D.max(refund, 0).toNumber() }
  })
  return { ...(await getTicket(result.noteId)), credited: result.credited, refund: result.refund }
}


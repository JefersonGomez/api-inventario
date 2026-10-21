// Punto de venta (Bloque 7A, decisiones del usuario del 20-oct-2026):
//  - Cajas por sucursal (límite del plan: maxRegistersPerBranch); cada una con su terminal de 5 dígitos
//    para el consecutivo y el ancho del tiquete (80 o 58 mm).
//  - Turno: se abre con el código de caja PROPIO y vigente (vencido = caja bloqueada hasta renovarlo,
//    también con el código del encargado) y un monto inicial; se cierra con arqueo por denominación.
//    Una caja abierta por persona y un turno abierto por caja (índices únicos parciales).
//  - Venta: tiquete + salida de stock (SALE) en la misma transacción. Sin stock suficiente no se vende.
//  - Descuentos (7B): por línea o sobre el total, de un tipo creado por el admin. SIEMPRE con el código
//    del encargado (sales.discount). Con cliente identificado sale factura en vez de tiquete.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { quantitySchema } from "../../shared/units.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { createMovement } from "../movements/movements.service.ts"
import { getDocument, issueDocument } from "../documents/document.service.ts"
import { authorizeWithPin, CodeExpiredError, renewWithManagerPin, verifyOwnPin } from "../users/pin.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"

const D = Prisma.Decimal
type Actor = { id: string; permissions: string[] }
const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
const money = z.number().min(0).max(1e12)
const pin = z.string().regex(/^\d{4,6}$/, "El código tiene de 4 a 6 dígitos")

export const createRegisterSchema = z.object({
  locationId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  ticketWidth: z.union([z.literal(80), z.literal(58)]).default(80),
  customerDisplay: z.boolean().default(false),
})
export const updateRegisterSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  ticketWidth: z.union([z.literal(80), z.literal(58)]).optional(),
  customerDisplay: z.boolean().optional(),
  isActive: z.boolean().optional(),
})
export const openSessionSchema = z.object({ registerId: z.uuid(), pin, openingAmount: money })
export const renewCodeSchema = z.object({ managerPin: pin })
export const cashMovementSchema = z.object({
  type: z.enum(["IN", "OUT"]),
  amount: money.positive(),
  reason: z.string().trim().min(1, "Indica el motivo").max(200),
})
// cierre del cajero: ciego, sin contar (el arqueo lo hace después la jefa de caja con él)
export const closeSessionSchema = z.object({ note: z.string().trim().max(500).optional() }).optional()
export const reconcileSchema = z.object({
  // { "20000": 3, "500": 12 }: valor de la denominación → cantidad
  denominations: z.record(z.string().regex(/^\d+(\.\d+)?$/), z.number().int().min(0).max(100_000)),
  cardDeclared: money.optional(), // total que imprimió el datáfono en su cierre (opcional, para comparar)
  note: z.string().trim().max(500).optional(),
})
export const sessionListQuerySchema = z.object({
  ...pageQuery,
  pending: z.enum(["1", "0"]).optional(), // 1 = cerradas sin arqueo
})
export const discountTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(["PERCENT", "AMOUNT"]),
    value: z.number().positive().max(1e9).nullable(), // null = el cajero escribe cuánto
    maxPercent: z.number().positive().max(100).nullable().optional(), // tope de los libres
    appliesTo: z.enum(["LINE", "TOTAL", "BOTH"]).default("BOTH"),
    isActive: z.boolean().default(true),
  })
  .refine((d) => d.value !== null || d.maxPercent, { message: "Un descuento libre necesita un tope (%)", path: ["maxPercent"] })
  .refine((d) => d.kind !== "PERCENT" || d.value === null || d.value <= 100, { message: "El porcentaje va de 0 a 100", path: ["value"] })
const discountPick = z.object({ typeId: z.uuid(), value: z.number().positive().max(1e9).optional() })
export const saleSchema = z.object({
  customerId: z.uuid().optional(),
  lines: z
    .array(
      z
        .object({
          productId: z.uuid(),
          quantity: quantitySchema,
          discount: discountPick.optional(),
          // ajuste de precio (precio de góndola mal): solo hacia abajo, con motivo y el código del encargado
          price: money.positive().optional(),
          priceReason: z.string().trim().min(3).max(60).optional(),
        })
        .refine((l) => l.price === undefined || l.priceReason, { message: "Indica el motivo del cambio de precio", path: ["priceReason"] })
    )
    .min(1)
    .max(500),
  discount: discountPick.optional(), // sobre el total: se reparte entre las líneas (Hacienda solo tiene descuento por línea)
  payments: z
    .array(
      z.object({
        method: z.enum(["CASH", "CARD", "SINPE"]),
        amount: money.positive(),
        reference: z.string().trim().max(60).optional(), // autorización del datáfono / comprobante SINPE
        tendered: money.optional(), // efectivo: lo que entregó el cliente
      })
    )
    .min(1)
    .max(5),
  notes: z.string().trim().max(500).optional(),
  negativePin: pin.optional(), // código del encargado que autoriza las negativas de esta venta
  discountPin: pin.optional(), // código del encargado que autoriza los descuentos y ajustes de precio de esta venta
})

// ---------- Tipos de descuento ----------

export async function listDiscountTypes() {
  return prisma.discountType.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] })
}

export async function saveDiscountType(id: string | null, input: z.infer<typeof discountTypeSchema>, userId: string) {
  const data = { ...input, maxPercent: input.value === null ? input.maxPercent! : null }
  if (id && !(await prisma.discountType.findFirst({ where: { id } }))) throw fail("Tipo de descuento no encontrado", 404)
  // se desactivan, no se borran: su nombre ya está en comprobantes
  const saved = id
    ? await prisma.discountType.update({ where: { id }, data })
    : await prisma.discountType.create({ data: { companyId: currentCompanyId(), ...data } })
  await logAudit(userId, id ? "UPDATE" : "CREATE", "DiscountType", saved.id, input)
  return saved
}

type DiscountRow = { id: string; name: string; kind: "PERCENT" | "AMOUNT"; value: Prisma.Decimal | null; maxPercent: Prisma.Decimal | null; appliesTo: "LINE" | "TOTAL" | "BOTH"; isActive: boolean }
type DiscountPick = { typeId: string; value?: number | undefined }
const r2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2)

// Monto (con IVA) de un descuento sobre una base. Los libres llevan el valor que escribe el cajero, hasta su tope.
function discountAmount(pick: DiscountPick, base: Prisma.Decimal, types: Map<string, DiscountRow>, scope: "LINE" | "TOTAL") {
  const type = types.get(pick.typeId)
  if (!type?.isActive) throw new Error("El tipo de descuento no existe o está desactivado")
  if (type.appliesTo !== "BOTH" && type.appliesTo !== scope) {
    throw new Error(`«${type.name}» es solo ${type.appliesTo === "LINE" ? "por línea" : "sobre el total"}`)
  }
  const value = type.value ?? (pick.value !== undefined ? new D(pick.value) : null)
  if (!value) throw new Error(`«${type.name}»: indica cuánto descontar`)
  const amount = type.kind === "PERCENT" ? r2(base.times(value).div(100)) : value
  if (type.value === null && amount.greaterThan(base.times(type.maxPercent!).div(100).plus(0.005))) {
    throw new Error(`«${type.name}» permite hasta ${type.maxPercent}%`)
  }
  if (amount.greaterThan(base)) throw new Error(`«${type.name}» descuenta más de lo que vale`)
  if (!amount.greaterThan(0)) throw new Error(`«${type.name}»: el descuento tiene que ser mayor que 0`)
  return { amount, label: type.name, describe: type.kind === "PERCENT" ? `${type.name} ${value}%` : `${type.name} ${value}` }
}

// Descuentos de la venta por línea (con IVA). El del total se reparte en proporción a lo que queda de
// cada línea; la más grande se lleva el redondeo. El frontend hace la misma cuenta (lib/pos.js).
export function computeDiscounts(grosses: Prisma.Decimal[], linePicks: (DiscountPick | undefined)[], totalPick: DiscountPick | undefined, types: Map<string, DiscountRow>) {
  const out = grosses.map(() => ({ amount: new D(0), labels: [] as string[] }))
  const described: string[] = []
  linePicks.forEach((pick, i) => {
    if (!pick) return
    const d = discountAmount(pick, grosses[i]!, types, "LINE")
    out[i] = { amount: d.amount, labels: [d.label] }
    described.push(`${d.describe} (línea ${i + 1})`)
  })
  if (totalPick) {
    const after = grosses.map((g, i) => g.minus(out[i]!.amount))
    const base = after.reduce((s, v) => s.plus(v), new D(0))
    const d = discountAmount(totalPick, base, types, "TOTAL")
    described.push(`${d.describe} (total)`)
    const biggest = after.reduce((b, v, i) => (v.greaterThan(after[b]!) ? i : b), 0)
    let given = new D(0)
    after.forEach((v, i) => {
      if (i === biggest || v.isZero()) return
      const share = r2(d.amount.times(v).div(base))
      out[i]!.amount = out[i]!.amount.plus(share)
      out[i]!.labels.push(d.label)
      given = given.plus(share)
    })
    out[biggest]!.amount = out[biggest]!.amount.plus(d.amount.minus(given))
    out[biggest]!.labels.push(d.label)
  }
  return { lines: out.map((o) => ({ amount: o.amount, label: o.labels.join(" + ") })), described }
}

// ---------- Cajas ----------

export async function listRegisters() {
  const scope = locationScope()
  return prisma.cashRegister.findMany({
    where: scope ? { locationId: { in: scope } } : {},
    include: {
      location: { select: { id: true, name: true, code: true } },
      sessions: { where: { status: "OPEN" }, select: { id: true, openedAt: true, openedBy: { select: { id: true, name: true } } } },
    },
    orderBy: [{ location: { name: "asc" } }, { terminalCode: "asc" }],
  })
}

export async function createRegister(input: z.infer<typeof createRegisterSchema>, userId: string) {
  const location = await prisma.location.findFirst({ where: { id: input.locationId, isActive: true } })
  if (!location) throw new Error("La sucursal no existe o está desactivada")
  if (location.type !== "BRANCH") throw new Error("Las cajas van en una sucursal, no en una bodega")
  const { maxRegistersPerBranch } = (await getCompany()).limits
  if (maxRegistersPerBranch !== null && (await prisma.cashRegister.count({ where: { locationId: location.id, isActive: true } })) >= maxRegistersPerBranch) {
    throw new Error(`Tu plan permite ${maxRegistersPerBranch} caja(s) por sucursal. Mejora tu plan para agregar más.`)
  }
  // terminal siguiente de la sucursal (las desactivadas también cuentan: su número ya está en tiquetes)
  const last = await prisma.cashRegister.findFirst({ where: { locationId: location.id }, orderBy: { terminalCode: "desc" }, select: { terminalCode: true } })
  const terminalCode = String(Number(last?.terminalCode ?? 0) + 1).padStart(5, "0")
  const register = await prisma.cashRegister.create({
    data: {
      companyId: currentCompanyId(), locationId: location.id, name: input.name, terminalCode,
      ticketWidth: input.ticketWidth, customerDisplay: input.customerDisplay,
    },
  })
  await logAudit(userId, "CREATE", "CashRegister", register.id, { name: register.name, terminalCode, location: location.name })
  return register
}

export async function updateRegister(id: string, input: z.infer<typeof updateRegisterSchema>, userId: string) {
  const register = await prisma.cashRegister.findFirst({ where: { id }, include: { sessions: { where: { status: "OPEN" }, select: { id: true } } } })
  if (!register) throw fail("Caja no encontrada", 404)
  if (input.isActive === false && register.sessions.length) throw new Error("La caja tiene un turno abierto: ciérralo antes de desactivarla")
  if (input.isActive && !register.isActive) {
    const { maxRegistersPerBranch } = (await getCompany()).limits
    if (maxRegistersPerBranch !== null && (await prisma.cashRegister.count({ where: { locationId: register.locationId, isActive: true } })) >= maxRegistersPerBranch) {
      throw new Error(`Tu plan permite ${maxRegistersPerBranch} caja(s) por sucursal`)
    }
  }
  const updated = await prisma.cashRegister.update({
    where: { id },
    data: {
      ...(input.name && { name: input.name }),
      ...(input.ticketWidth && { ticketWidth: input.ticketWidth }),
      ...(input.customerDisplay !== undefined && { customerDisplay: input.customerDisplay }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  })
  await logAudit(userId, "UPDATE", "CashRegister", id, input)
  return updated
}

// ---------- Turnos ----------

const sessionInclude = {
  register: { include: { location: { select: { id: true, name: true, code: true } } } },
  openedBy: { select: { id: true, name: true } },
} satisfies Prisma.CashSessionInclude

// Efectivo esperado y totales por medio de pago del turno.
// ponytail: solo ventas (tiquete/factura); las devoluciones en efectivo restan desde 7C.
export async function sessionSummary(sessionId: string) {
  const session = await prisma.cashSession.findFirst({ where: { id: sessionId }, select: { openingAmount: true } })
  if (!session) throw fail("Turno no encontrado", 404)
  const [byMethod, sales, movements] = await Promise.all([
    prisma.documentPayment.groupBy({
      by: ["method"],
      where: { document: { cashSessionId: sessionId, type: { in: ["TICKET", "INVOICE"] } } },
      _sum: { amount: true },
    }),
    prisma.document.aggregate({ where: { cashSessionId: sessionId, type: { in: ["TICKET", "INVOICE"] } }, _count: true, _sum: { total: true } }),
    prisma.cashMovement.groupBy({ by: ["type"], where: { sessionId }, _sum: { amount: true } }),
  ])
  const payments = Object.fromEntries(byMethod.map((m) => [m.method, (m._sum.amount ?? new D(0)).toDecimalPlaces(2).toNumber()]))
  const mov = (t: "IN" | "OUT") => movements.find((m) => m.type === t)?._sum.amount ?? new D(0)
  const expectedCash = new D(session.openingAmount).plus(payments.CASH ?? 0).plus(mov("IN")).minus(mov("OUT")).toDecimalPlaces(2)
  return {
    openingAmount: session.openingAmount.toNumber(),
    salesCount: sales._count,
    salesTotal: (sales._sum.total ?? new D(0)).toDecimalPlaces(2).toNumber(),
    payments, // { CASH, CARD, SINPE }
    cashIn: mov("IN").toNumber(),
    cashOut: mov("OUT").toNumber(),
    expectedCash: expectedCash.toNumber(),
  }
}

async function myOpenSession(userId: string) {
  return prisma.cashSession.findFirst({ where: { openedById: userId, status: "OPEN" }, include: sessionInclude })
}

async function requireMyOpenSession(userId: string) {
  const session = await myOpenSession(userId)
  if (!session) throw fail("No tienes una caja abierta", 409, "NO_SESSION")
  return session
}

// Cierre ciego: el efectivo esperado solo lo ve quien hace arqueos (cash.reconcile)
const blind = <T extends { expectedCash?: unknown }>(summary: T, actor: Actor) => {
  if (actor.permissions.includes("cash.reconcile")) return summary
  const { expectedCash: _hidden, ...rest } = summary
  return rest
}

// La caja abierta de la persona (o null) con su resumen
export async function currentSession(actor: Actor) {
  const session = await myOpenSession(actor.id)
  return session && { ...session, summary: blind(await sessionSummary(session.id), actor) }
}

export async function openSession(input: z.infer<typeof openSessionSchema>, actor: Actor) {
  const register = await prisma.cashRegister.findFirst({ where: { id: input.registerId, isActive: true } })
  if (!register) throw new Error("La caja no existe o está desactivada")
  assertLocationAllowed(register.locationId)
  try {
    await verifyOwnPin(actor.id, input.pin)
  } catch (e) {
    if (e instanceof CodeExpiredError) throw fail(e.message, 423, "PIN_EXPIRED")
    throw e
  }
  try {
    const session = await prisma.cashSession.create({
      data: { companyId: currentCompanyId(), registerId: register.id, openedById: actor.id, openingAmount: input.openingAmount },
    })
    await logAudit(actor.id, "CREATE", "CashSession", session.id, { register: register.name, openingAmount: input.openingAmount })
    return (await currentSession(actor))!
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw fail("Esta caja ya está abierta, o ya tienes otra caja abierta", 409)
    }
    throw e
  }
}

// Caja bloqueada por código vencido: el encargado escribe SU código y el cajero recibe uno nuevo
export async function renewCodeWithManager(input: z.infer<typeof renewCodeSchema>, actor: Actor) {
  const result = await renewWithManagerPin(actor.id, input.managerPin)
  if (!result) throw fail("Ese código no sirve para renovar el tuyo (tiene que ser de un encargado o del administrador, vigente)", 403)
  return result // { pin }: se muestra una vez
}

export async function addCashMovement(input: z.infer<typeof cashMovementSchema>, actor: Actor) {
  const session = await requireMyOpenSession(actor.id)
  if (input.type === "OUT" && new D(input.amount).greaterThan((await sessionSummary(session.id)).expectedCash)) {
    throw new Error("No hay tanto efectivo en la caja")
  }
  const movement = await prisma.cashMovement.create({
    data: { companyId: currentCompanyId(), sessionId: session.id, type: input.type, amount: input.amount, reason: input.reason, userId: actor.id },
  })
  await logAudit(actor.id, "CREATE", "CashMovement", movement.id, input)
  return movement
}

export async function listCashMovements(userId: string) {
  const session = await requireMyOpenSession(userId)
  return prisma.cashMovement.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "desc" } })
}

// Paso 1 — cierre del cajero (ciego): ya no se vende en ese turno y queda pendiente de arqueo.
// Cierra su propio turno, o quien administra el equipo o hace arqueos (cajero que se fue sin cerrar).
export async function closeSession(id: string, input: z.infer<typeof closeSessionSchema>, actor: Actor) {
  const session = await prisma.cashSession.findFirst({ where: { id, status: "OPEN" }, include: { register: true } })
  if (!session) throw fail("El turno no existe o ya está cerrado", 404)
  const manages = actor.permissions.includes("users.manage") || actor.permissions.includes("cash.reconcile")
  if (session.openedById !== actor.id && !manages) throw fail("Solo quien abrió la caja puede cerrarla", 403)
  assertLocationAllowed(session.register.locationId)

  const summary = await sessionSummary(id)
  // updateMany con status OPEN: dos cierres a la vez no pasan los dos
  const { count } = await prisma.cashSession.updateMany({
    where: { id, status: "OPEN" },
    data: { status: "CLOSED", closedById: actor.id, closedAt: new Date(), expectedCash: summary.expectedCash, closingNote: input?.note || null },
  })
  if (!count) throw fail("El turno ya está cerrado", 409)
  await logAudit(actor.id, "UPDATE", "CashSession", id, { closed: true, expectedCash: summary.expectedCash })
  return getSessionReport(id, actor)
}

// Paso 2 — arqueo: la jefa de caja cuenta el efectivo con el cajero (por denominación) y, si quiere,
// anota el total del cierre en papel del datáfono para compararlo con lo cobrado con tarjeta.
export async function reconcileSession(id: string, input: z.infer<typeof reconcileSchema>, actor: Actor) {
  const session = await prisma.cashSession.findFirst({ where: { id }, include: { register: true } })
  if (!session) throw fail("Turno no encontrado", 404)
  assertLocationAllowed(session.register.locationId)
  if (session.status === "OPEN") throw new Error("La caja sigue abierta: el cajero tiene que cerrarla antes del arqueo")
  if (session.reconciledAt) throw fail("Este cierre ya tiene arqueo", 409)
  if (session.openedById === actor.id && !actor.permissions.includes("users.manage")) {
    throw fail("El arqueo de tu propia caja lo hace otra persona", 403)
  }

  const expected = new D(session.expectedCash ?? 0)
  const countedCash = Object.entries(input.denominations).reduce((s, [value, n]) => s.plus(new D(value).times(n)), new D(0)).toDecimalPlaces(2)
  const difference = countedCash.minus(expected)
  const { count } = await prisma.cashSession.updateMany({
    where: { id, reconciledAt: null },
    data: {
      reconciledById: actor.id, reconciledAt: new Date(), countedCash, difference, denominations: input.denominations,
      ...(input.cardDeclared !== undefined && { cardDeclared: input.cardDeclared }), reconcileNote: input.note || null,
    },
  })
  if (!count) throw fail("Este cierre ya tiene arqueo", 409)
  await logAudit(actor.id, "UPDATE", "CashSession", id, {
    reconciled: true, expectedCash: expected.toNumber(), countedCash: countedCash.toNumber(), difference: difference.toNumber(),
    ...(input.cardDeclared !== undefined && { cardDeclared: input.cardDeclared }),
  })
  return getSessionReport(id, actor)
}

// Cierres para la jefa de caja: pendientes de arqueo (pending=1) o todos, de sus sucursales
export async function listSessions(f: z.infer<typeof sessionListQuerySchema>) {
  const scope = locationScope()
  const where: Prisma.CashSessionWhereInput = {
    status: "CLOSED",
    ...(f.pending === "1" && { reconciledAt: null }),
    ...(f.pending === "0" && { reconciledAt: { not: null } }),
    ...(scope && { register: { locationId: { in: scope } } }),
  }
  const [total, items, pending] = await Promise.all([
    prisma.cashSession.count({ where }),
    prisma.cashSession.findMany({
      where,
      include: { ...sessionInclude, closedBy: { select: { id: true, name: true } }, reconciledBy: { select: { id: true, name: true } } },
      orderBy: { closedAt: "desc" },
      ...pageArgs(f),
    }),
    prisma.cashSession.count({ where: { ...where, reconciledAt: null } }),
  ])
  return { ...pageResult(items, total, f), pendingCount: pending }
}

// Reporte del turno (para imprimir el cierre y el acta del arqueo). El cajero lo ve sin el esperado
// ni la diferencia hasta que hay arqueo... y aun después, solo quien hace arqueos ve el esperado.
export async function getSessionReport(id: string, actor: Actor) {
  const session = await prisma.cashSession.findFirst({
    where: { id },
    include: {
      ...sessionInclude,
      closedBy: { select: { id: true, name: true } },
      reconciledBy: { select: { id: true, name: true } },
      movements: { orderBy: { createdAt: "asc" }, select: { id: true, type: true, amount: true, reason: true, createdAt: true } },
    },
  })
  if (!session) throw fail("Turno no encontrado", 404)
  assertLocationAllowed(session.register.locationId)
  const reconciler = actor.permissions.includes("cash.reconcile")
  if (session.openedById !== actor.id && !reconciler) throw fail("Turno no encontrado", 404)
  const summary = await sessionSummary(id)
  const { expectedCash, countedCash, difference, denominations, cardDeclared, ...rest } = session
  const company = await getCompany()
  return {
    ...rest,
    company: { name: company.name, currency: company.currency },
    summary: blind({ ...summary, expectedCash: Number(expectedCash ?? summary.expectedCash) }, actor),
    // el conteo lo ven los dos (lo hicieron juntos); esperado y diferencia, solo quien hace arqueos
    countedCash: countedCash && Number(countedCash),
    denominations,
    cardDeclared: cardDeclared && Number(cardDeclared),
    ...(reconciler && {
      expectedCash: Number(expectedCash ?? summary.expectedCash),
      difference: difference && Number(difference),
      cardDifference: cardDeclared ? Number(new D(cardDeclared).minus(summary.payments.CARD ?? 0)) : null,
    }),
  }
}

// ---------- Venta ----------

export async function sell(input: z.infer<typeof saleSchema>, actor: Actor) {
  const session = await requireMyOpenSession(actor.id)
  const { register } = session
  for (const p of input.payments) {
    if (p.tendered !== undefined && (p.method !== "CASH" || p.tendered < p.amount)) {
      throw new Error("Lo recibido en efectivo no puede ser menor que el monto")
    }
  }

  // stock suficiente en la sucursal de la caja (aviso claro antes; el increment atómico lo garantiza igual)
  const wanted = new Map<string, number>()
  for (const l of input.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.quantity)
  const products = await prisma.product.findMany({
    where: { id: { in: [...wanted.keys()] }, deletedAt: null },
    select: { id: true, name: true, price: true, unit: true, tracksLots: true, stocks: { where: { locationId: register.locationId }, select: { quantity: true } } },
  })
  if (products.length !== wanted.size) throw new Error("Algún producto no existe")
  const stockOf = (p: (typeof products)[number]) => new D(p.stocks[0]?.quantity ?? 0)
  const short = products.filter((p) => stockOf(p).lessThan(wanted.get(p.id)!))
  const describe = (list: typeof products) => list.map((p) => `${p.name} (hay ${stockOf(p).toNumber()})`).join(", ")
  // con lotes no hay negativa: sin stock no se sabe de qué lote sale
  const withLots = short.filter((p) => p.tracksLots)
  if (withLots.length) throw fail(`Sin stock suficiente en ${register.location.name}: ${describe(withLots)}`, 409, "NO_STOCK")
  // negativas: venden igual, con el código de un encargado (sales.negative)
  let authorizedBy: { id: string; name: string } | null = null
  if (short.length) {
    if (!input.negativePin) {
      throw Object.assign(fail(`Negativa: el sistema no tiene stock suficiente de ${describe(short)}. Pide el código del encargado.`, 409, "NEGATIVE_NEEDS_AUTH"), {
        shortages: short.map((p) => ({ productId: p.id, name: p.name, stock: stockOf(p).toNumber(), wanted: wanted.get(p.id)! })),
      })
    }
    const auth = await authorizeWithPin(actor.id, input.negativePin, "sales.negative", `Negativa: ${describe(short)}`)
    if (!auth) throw fail("Ese código no autoriza negativas (tiene que ser de un encargado, vigente)", 403)
    authorizedBy = auth.authorizedBy
  }

  // descuentos y ajustes de precio: siempre con el código del encargado. El ajuste va como descuento
  // (el comprobante lleva el precio del catálogo y la diferencia, como lo pide Hacienda)
  const byId = new Map(products.map((p) => [p.id, p]))
  const hasDiscount = !!input.discount || input.lines.some((l) => l.discount || l.price !== undefined)
  let discounts: ReturnType<typeof computeDiscounts>["lines"] = []
  let discountAuthorizedById: string | undefined
  if (hasDiscount) {
    const types = new Map((await prisma.discountType.findMany()).map((t) => [t.id, t as DiscountRow]))
    const adjusts = input.lines.map((l) => {
      const p = byId.get(l.productId)!
      if (l.price === undefined) return null
      if (!new D(l.price).lessThan(p.price)) throw new Error(`${p.name}: el precio nuevo tiene que ser menor que ${p.price}`)
      return { amount: r2(new D(p.price).minus(l.price).times(l.quantity)), label: `Ajuste de precio: ${l.priceReason}`, describe: `${p.name} ${p.price} → ${l.price} (${l.priceReason})` }
    })
    const grosses = input.lines.map((l) => new D(l.price ?? byId.get(l.productId)!.price).times(l.quantity))
    const computed = computeDiscounts(grosses, input.lines.map((l) => l.discount), input.discount, types)
    computed.described.unshift(...adjusts.flatMap((a) => (a ? [a.describe] : [])))
    discounts = computed.lines.map((d, i) => {
      const a = adjusts[i]
      return a ? { amount: d.amount.plus(a.amount), label: [a.label, d.label].filter(Boolean).join(" + ") } : d
    })
    if (!input.discountPin) throw fail("Los descuentos los autoriza el encargado con su código", 409, "DISCOUNT_NEEDS_AUTH")
    const auth = await authorizeWithPin(actor.id, input.discountPin, "sales.discount", `Descuentos: ${computed.described.join(", ")}`.slice(0, 200))
    if (!auth) throw fail("Ese código no autoriza descuentos (tiene que ser de un encargado, vigente)", 403, "DISCOUNT_PIN")
    discountAuthorizedById = auth.authorizedBy.id
  }
  // con cliente identificado: factura (el cliente la puede usar para su contabilidad)
  const customer = input.customerId
    ? await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { idType: true, idNumber: true } })
    : null
  if (input.customerId && !customer) throw new Error("El cliente no existe")

  const doc = await prisma.$transaction(async (tx) => {
    const doc = await issueDocument(
      {
        type: customer?.idType && customer.idNumber ? "INVOICE" : "TICKET",
        ...(input.customerId && { customerId: input.customerId }),
        lines: input.lines.map((l, i) => {
          const d = discounts[i]
          return {
            productId: l.productId, quantity: l.quantity,
            ...(d && d.amount.greaterThan(0) && { discountWithTax: d.amount.toNumber(), discountLabel: d.label }),
          }
        }),
        ...(discountAuthorizedById && { discountAuthorizedById }),
        payments: input.payments,
        ...(input.notes && { notes: input.notes }),
        branchCode: register.location.code ?? "001",
        terminalCode: register.terminalCode,
        cashSessionId: session.id,
      },
      actor.id,
      tx
    )
    for (const l of input.lines) {
      await createMovement(l.productId, actor.id, "OUT", l.quantity, `Venta ${doc.consecutive}`, tx, {
        source: "SALE", sourceId: doc.id, locationId: register.locationId, allowNegative: !!authorizedBy,
      })
    }
    if (authorizedBy) {
      await tx.stockNegative.createMany({
        data: short.map((p) => ({
          companyId: currentCompanyId(), productId: p.id, locationId: register.locationId, documentId: doc.id,
          quantity: new D(wanted.get(p.id)!).minus(D.max(stockOf(p), 0)), stockBefore: stockOf(p),
          reportedById: actor.id, authorizedById: authorizedBy.id,
        })),
      })
      // aviso a quien maneja el inventario de esa sucursal
      const ids = await memberIdsWith("stock.move", register.locationId)
      await createNotifications(
        ids.flatMap((userId) =>
          short.map((p) => ({
            userId, type: "stockNegative", title: p.name, link: "/negatives",
            meta: { location: register.location.name, quantity: new D(wanted.get(p.id)!).minus(D.max(stockOf(p), 0)).toNumber(), unit: p.unit, cashier: session.openedBy.name },
          }))
        ),
        tx
      )
    }
    return doc
  })
  return { ...(await getTicket(doc.id)), negatives: authorizedBy ? short.length : 0 }
}

// Todo lo que lleva el tiquete impreso: comprobante, emisor, sucursal, caja y cajero
export async function getTicket(documentId: string) {
  const doc = await getDocument(documentId)
  const session = doc.cashSessionId
    ? await prisma.cashSession.findFirst({ where: { id: doc.cashSessionId }, include: sessionInclude })
    : null
  if (session) assertLocationAllowed(session.register.locationId)
  const c = await getCompany()
  return {
    document: doc,
    company: {
      name: c.name, legalName: c.legalName, idType: c.idType, idNumber: c.idNumber, phone: c.phone,
      email: c.invoiceEmail, addressDetail: c.addressDetail, currency: c.currency,
    },
    register: session && { name: session.register.name, terminalCode: session.register.terminalCode, ticketWidth: session.register.ticketWidth },
    location: session?.register.location ?? null,
    cashier: doc.createdBy,
  }
}

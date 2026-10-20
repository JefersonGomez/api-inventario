// Punto de venta (Bloque 7A, decisiones del usuario del 20-oct-2026):
//  - Cajas por sucursal (límite del plan: maxRegistersPerBranch); cada una con su terminal de 5 dígitos
//    para el consecutivo y el ancho del tiquete (80 o 58 mm).
//  - Turno: se abre con el código de caja PROPIO y vigente (vencido = caja bloqueada hasta renovarlo,
//    también con el código del encargado) y un monto inicial; se cierra con arqueo por denominación.
//    Una caja abierta por persona y un turno abierto por caja (índices únicos parciales).
//  - Venta: tiquete + salida de stock (SALE) en la misma transacción. Sin stock suficiente no se vende.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { quantitySchema } from "../../shared/units.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { createMovement } from "../movements/movements.service.ts"
import { getDocument, issueDocument } from "../documents/document.service.ts"
import { CodeExpiredError, renewWithManagerPin, verifyOwnPin } from "../users/pin.service.ts"

const D = Prisma.Decimal
type Actor = { id: string; permissions: string[] }
const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
const money = z.number().min(0).max(1e12)
const pin = z.string().regex(/^\d{4,6}$/, "El código tiene de 4 a 6 dígitos")

export const createRegisterSchema = z.object({
  locationId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  ticketWidth: z.union([z.literal(80), z.literal(58)]).default(80),
})
export const updateRegisterSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  ticketWidth: z.union([z.literal(80), z.literal(58)]).optional(),
  isActive: z.boolean().optional(),
})
export const openSessionSchema = z.object({ registerId: z.uuid(), pin, openingAmount: money })
export const renewCodeSchema = z.object({ managerPin: pin })
export const cashMovementSchema = z.object({
  type: z.enum(["IN", "OUT"]),
  amount: money.positive(),
  reason: z.string().trim().min(1, "Indica el motivo").max(200),
})
export const closeSessionSchema = z.object({
  // { "20000": 3, "500": 12 }: valor de la denominación → cantidad
  denominations: z.record(z.string().regex(/^\d+(\.\d+)?$/), z.number().int().min(0).max(100_000)),
  note: z.string().trim().max(500).optional(),
})
export const saleSchema = z.object({
  customerId: z.uuid().optional(),
  lines: z.array(z.object({ productId: z.uuid(), quantity: quantitySchema })).min(1).max(500),
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
})

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
    data: { companyId: currentCompanyId(), locationId: location.id, name: input.name, terminalCode, ticketWidth: input.ticketWidth },
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

// La caja abierta de la persona (o null) con su resumen
export async function currentSession(userId: string) {
  const session = await myOpenSession(userId)
  return session && { ...session, summary: await sessionSummary(session.id) }
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
    return (await currentSession(actor.id))!
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

// Cierre con arqueo: cierra su propio turno, o cualquiera quien administra el equipo (cajero que se fue sin cerrar)
export async function closeSession(id: string, input: z.infer<typeof closeSessionSchema>, actor: Actor) {
  const session = await prisma.cashSession.findFirst({ where: { id, status: "OPEN" }, include: { register: true } })
  if (!session) throw fail("El turno no existe o ya está cerrado", 404)
  if (session.openedById !== actor.id && !actor.permissions.includes("users.manage")) throw fail("Solo quien abrió la caja puede cerrarla", 403)
  assertLocationAllowed(session.register.locationId)

  const summary = await sessionSummary(id)
  const countedCash = Object.entries(input.denominations).reduce((s, [value, n]) => s.plus(new D(value).times(n)), new D(0)).toDecimalPlaces(2)
  const difference = countedCash.minus(summary.expectedCash)
  // updateMany con status OPEN: dos cierres a la vez no pasan los dos
  const { count } = await prisma.cashSession.updateMany({
    where: { id, status: "OPEN" },
    data: {
      status: "CLOSED", closedById: actor.id, closedAt: new Date(),
      expectedCash: summary.expectedCash, countedCash, difference,
      denominations: input.denominations, closingNote: input.note || null,
    },
  })
  if (!count) throw fail("El turno ya está cerrado", 409)
  await logAudit(actor.id, "UPDATE", "CashSession", id, {
    closed: true, expectedCash: summary.expectedCash, countedCash: countedCash.toNumber(), difference: difference.toNumber(),
  })
  return { ...summary, countedCash: countedCash.toNumber(), difference: difference.toNumber() }
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
    select: { id: true, name: true, stocks: { where: { locationId: register.locationId }, select: { quantity: true } } },
  })
  if (products.length !== wanted.size) throw new Error("Algún producto no existe")
  const short = products.filter((p) => new D(p.stocks[0]?.quantity ?? 0).lessThan(wanted.get(p.id)!))
  if (short.length) {
    throw fail(`Sin stock suficiente en ${register.location.name}: ${short.map((p) => `${p.name} (hay ${Number(p.stocks[0]?.quantity ?? 0)})`).join(", ")}`, 409, "NO_STOCK")
  }

  const doc = await prisma.$transaction(async (tx) => {
    const doc = await issueDocument(
      {
        type: "TICKET",
        ...(input.customerId && { customerId: input.customerId }),
        lines: input.lines,
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
        source: "SALE", sourceId: doc.id, locationId: register.locationId,
      })
    }
    return doc
  })
  return getTicket(doc.id)
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

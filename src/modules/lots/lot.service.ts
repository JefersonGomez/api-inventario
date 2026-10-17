// Lotes con vencimiento (Bloque 5C). Solo para productos con tracksLots (decisión del usuario: los que se
// marquen, p. ej. alimentos y medicinas). La suma de los lotes de una ubicación es su ProductStock.
// Entradas: al lote indicado (código + vencimiento). Salidas: primero el que vence antes (FEFO).
import { z } from "zod"
import { prisma, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId, locationScope } from "../../shared/tenant.ts"

export const lotSchema = z.object({
  code: z.string().trim().min(1, "Indica el código del lote").max(40),
  expiresAt: z.coerce.date().nullable().optional(), // null = sin vencimiento conocido
})
export type LotInput = z.infer<typeof lotSchema>
export type LotMove = { code: string; expiresAt: Date | null; quantity: number }

// Código para entradas sin dato de lote (sobrante de un conteo, por ejemplo)
export const NO_LOT = "SIN-LOTE"

// Mueve los lotes de un producto en una ubicación y devuelve qué lotes tocó (va en el movimiento).
// delta > 0: entra al lote indicado (o al de por defecto); delta < 0: sale de los que vencen antes.
export async function applyLots(
  tx: Db,
  p: { productId: string; locationId: string; delta: number; lot?: LotInput | null | undefined; defaultCode?: string | undefined }
): Promise<LotMove[]> {
  if (p.delta > 0) {
    const code = p.lot?.code ?? p.defaultCode
    if (!code) throw new Error("Este producto maneja lotes: indica el lote y su vencimiento")
    const expiresAt = p.lot ? (p.lot.expiresAt ?? null) : null
    const row = await tx.productLot.upsert({
      where: { productId_locationId_code: { productId: p.productId, locationId: p.locationId, code } },
      create: { companyId: currentCompanyId(), productId: p.productId, locationId: p.locationId, code, expiresAt, quantity: p.delta },
      // mismo lote otra vez: suma; si ahora trae vencimiento, se guarda
      update: { quantity: { increment: p.delta }, ...(p.lot?.expiresAt && { expiresAt: p.lot.expiresAt }) },
    })
    return [{ code, expiresAt: row.expiresAt, quantity: p.delta }]
  }

  let remaining = new Prisma.Decimal(-p.delta)
  const lots = await tx.productLot.findMany({
    where: { productId: p.productId, locationId: p.locationId, quantity: { gt: 0 } },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  })
  const used: LotMove[] = []
  for (const lot of lots) {
    if (remaining.lte(0)) break
    const take = Prisma.Decimal.min(lot.quantity, remaining)
    // decremento condicionado: si otra venta se llevó este lote a la vez, falla en vez de quedar negativo
    const { count } = await tx.productLot.updateMany({
      where: { id: lot.id, quantity: { gte: take } },
      data: { quantity: { decrement: take } },
    })
    if (count !== 1) throw new Error("El stock del lote cambió mientras se registraba: intenta de nuevo")
    used.push({ code: lot.code, expiresAt: lot.expiresAt, quantity: Number(take) })
    remaining = remaining.minus(take)
  }
  if (remaining.gt(0)) throw new Error("No hay suficiente en los lotes de esta ubicación")
  return used
}

// Vuelve a meter lotes conocidos (recepción o cancelación de una transferencia), tal cual salieron
export async function restoreLots(tx: Db, productId: string, locationId: string, lots: LotMove[]) {
  for (const l of lots) {
    if (l.quantity > 0) {
      await applyLots(tx, { productId, locationId, delta: l.quantity, lot: { code: l.code, expiresAt: l.expiresAt ? new Date(l.expiresAt) : null } })
    }
  }
}

// Reparte una cantidad sobre lotes en su orden (lo que llegó de una transferencia: los que vencen antes primero)
export function takeFromLots(lots: LotMove[], quantity: number): LotMove[] {
  let left = new Prisma.Decimal(quantity)
  const out: LotMove[] = []
  for (const l of lots) {
    if (left.lte(0)) break
    const take = Prisma.Decimal.min(l.quantity, left)
    out.push({ ...l, quantity: Number(take) })
    left = left.minus(take)
  }
  return out
}

// Al empezar a manejar lotes, el stock que ya había entra a un lote "INICIAL" por ubicación
// (con la fecha de vencimiento que tenía el producto). Al dejar de manejarlos, se borran.
export async function setTracksLots(tx: Db, productId: string, tracks: boolean, expirationDate: Date | null) {
  if (!tracks) {
    await tx.productLot.deleteMany({ where: { productId } })
    return
  }
  const stocks = await tx.productStock.findMany({ where: { productId, quantity: { gt: 0 } } })
  for (const s of stocks) {
    await tx.productLot.upsert({
      where: { productId_locationId_code: { productId, locationId: s.locationId, code: "INICIAL" } },
      create: { companyId: currentCompanyId(), productId, locationId: s.locationId, code: "INICIAL", expiresAt: expirationDate, quantity: s.quantity },
      update: {},
    })
  }
}

// Lotes con existencia que vencen en los próximos días (en las ubicaciones que ve la persona)
export function getExpiringLots(daysAhead = 7) {
  const now = new Date()
  const limit = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)
  const scope = locationScope()
  return prisma.productLot.findMany({
    where: {
      quantity: { gt: 0 },
      expiresAt: { not: null, lte: limit },
      product: { deletedAt: null, tracksLots: true },
      ...(scope && { locationId: { in: scope } }),
    },
    include: { product: { select: { id: true, name: true, unit: true } }, location: { select: { id: true, name: true } } },
    orderBy: { expiresAt: "asc" },
  })
}

// Lotes de un producto (detalle), en las ubicaciones que ve la persona
export function lotsOf(productId: string) {
  const scope = locationScope()
  return prisma.productLot.findMany({
    where: { productId, quantity: { gt: 0 }, ...(scope && { locationId: { in: scope } }) },
    select: { id: true, code: true, expiresAt: true, quantity: true, location: { select: { id: true, name: true } } },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  })
}

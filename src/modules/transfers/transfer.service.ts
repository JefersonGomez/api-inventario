// Transferencias entre ubicaciones en dos pasos (Bloque 4B, decisiones del usuario del 16-oct-2026):
//  - Enviar: el stock sale del origen y queda "en tránsito". Sigue contando en el total de la empresa
//    (Product.stock no cambia): es mercadería propia viajando.
//  - Recibir: entra al destino lo que llegó; la diferencia es faltante y sale del total.
//  - Cancelar (solo en tránsito): vuelve todo al origen.
// Envía y recibe quien tiene stock.move y trabaja en esa ubicación; cancela quien envió, o quien
// gestiona compras (encargado) o el admin.
import { z } from "zod"
import { prisma, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { assertQuantityForUnit, quantitySchema } from "../../shared/units.ts"
import { resolveLocation } from "../locations/location.service.ts"
import { logAudit } from "../audit/audit.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { memberIdsWith } from "../userGestion/userGestion.service.ts"
import { applyLots, restoreLots, takeFromLots, type LotMove } from "../lots/lot.service.ts"

export const createTransferSchema = z.object({
  fromLocationId: z.uuid().optional(), // sin indicar: la ubicación activa
  toLocationId: z.uuid(),
  notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ productId: z.uuid(), quantity: quantitySchema })).min(1).max(200),
})
export const receiveTransferSchema = z
  .object({
    // sin items: llegó todo. Con items: lo que llegó de cada línea (0 = no llegó nada)
    items: z.array(z.object({ itemId: z.uuid(), receivedQuantity: z.number().min(0) })).optional(),
  })
  .optional()
export const transferListQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(),
})
export type TransferListQuery = z.infer<typeof transferListQuerySchema>

type Actor = { id: string; permissions: string[] }

const detail = {
  fromLocation: { select: { id: true, name: true, type: true } },
  toLocation: { select: { id: true, name: true, type: true } },
  sentBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, name: true, sku: true, unit: true, tracksLots: true } } } },
} satisfies Prisma.StockTransferInclude

// Mueve el stock de una ubicación (increment atómico; falla si queda negativo) y deja el movimiento.
// El total del producto no se toca: en tránsito sigue siendo de la empresa.
// Productos con lotes: al salir se toman los que vencen antes; al entrar, los lotes que viajaron (lots).
async function moveAt(
  tx: Db,
  m: {
    productId: string; locationId: string; locationName: string; delta: number; userId: string; transferId: string; reason: string
    tracksLots?: boolean; lots?: LotMove[]
  }
): Promise<LotMove[] | null> {
  const row = await tx.productStock.upsert({
    where: { productId_locationId: { productId: m.productId, locationId: m.locationId } },
    create: { companyId: currentCompanyId(), productId: m.productId, locationId: m.locationId, quantity: m.delta },
    update: { quantity: { increment: m.delta } },
  })
  if (row.quantity.isNegative()) throw new Error(`Stock insuficiente en ${m.locationName}`)
  let lots: LotMove[] | null = null
  if (m.tracksLots) {
    if (m.delta < 0) lots = await applyLots(tx, { productId: m.productId, locationId: m.locationId, delta: m.delta })
    else {
      lots = m.lots ?? []
      await restoreLots(tx, m.productId, m.locationId, lots)
    }
  }
  await tx.stockMovement.create({
    data: {
      companyId: currentCompanyId(), productId: m.productId, userId: m.userId, locationId: m.locationId,
      type: m.delta > 0 ? "IN" : "OUT", quantity: Math.abs(m.delta), reason: m.reason, source: "TRANSFER", sourceId: m.transferId,
      ...(lots && { lots: lots as unknown as Prisma.InputJsonValue }),
    },
  })
  return lots
}

// Las que ve la persona: donde sale o llega alguna de sus ubicaciones (la activa, o todas las suyas)
export async function listTransfers(f: TransferListQuery) {
  const scope = locationScope()
  const where: Prisma.StockTransferWhereInput = {
    ...(f.status && { status: f.status }),
    ...(scope && { OR: [{ fromLocationId: { in: scope } }, { toLocationId: { in: scope } }] }),
  }
  const [total, items] = await Promise.all([
    prisma.stockTransfer.count({ where }),
    prisma.stockTransfer.findMany({ where, include: detail, orderBy: { sentAt: "desc" }, ...pageArgs(f) }),
  ])
  return pageResult(items, total, f)
}

export async function getTransfer(id: string) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id }, include: detail })
  if (!transfer) throw new Error("Transferencia no encontrada")
  const scope = locationScope()
  if (scope && !scope.includes(transfer.fromLocationId) && !scope.includes(transfer.toLocationId)) {
    throw new Error("Transferencia no encontrada")
  }
  return transfer
}

export async function createTransfer(input: z.infer<typeof createTransferSchema>, actor: Actor) {
  const from = await resolveLocation(input.fromLocationId)
  const to = await prisma.location.findFirst({ where: { id: input.toLocationId, isActive: true } })
  if (!to) throw new Error("El destino no existe o está desactivado")
  if (to.id === from.id) throw new Error("El origen y el destino tienen que ser distintos")

  const ids = input.items.map((i) => i.productId)
  if (new Set(ids).size !== ids.length) throw new Error("Hay productos repetidos en la transferencia")
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, unit: true, tracksLots: true } })
  if (products.length !== ids.length) throw new Error("Algún producto no existe")
  for (const p of products) {
    assertQuantityForUnit(input.items.find((i) => i.productId === p.id)!.quantity, p.unit, `La cantidad de "${p.name}"`)
  }

  const { id } = await prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.create({
      data: {
        companyId: currentCompanyId(),
        fromLocationId: from.id,
        toLocationId: to.id,
        sentById: actor.id,
        notes: input.notes || null,
        items: { create: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
      },
      select: { id: true },
    })
    const created = await tx.stockTransferItem.findMany({ where: { transferId: transfer.id }, select: { id: true, productId: true } })
    for (const item of input.items) {
      const tracksLots = products.find((p) => p.id === item.productId)!.tracksLots
      const lots = await moveAt(tx, {
        productId: item.productId, locationId: from.id, locationName: from.name, delta: -item.quantity,
        userId: actor.id, transferId: transfer.id, reason: `Transferencia a ${to.name}`, tracksLots,
      })
      // los lotes que salieron viajan con la transferencia (para entrar igual al destino)
      if (lots) {
        const itemId = created.find((c) => c.productId === item.productId)!.id
        await tx.stockTransferItem.update({ where: { id: itemId }, data: { lots: lots as unknown as Prisma.InputJsonValue } })
      }
    }
    await logAudit(actor.id, "CREATE", "StockTransfer", transfer.id, { from: from.id, to: to.id, items: input.items }, tx)
    // avisa a quienes reciben en el destino (no a quien la envía)
    const recipients = (await memberIdsWith("stock.move", to.id)).filter((u) => u !== actor.id)
    await createNotifications(
      recipients.map((userId) => ({
        userId, type: "transferIncoming", title: from.name, link: `/transfers?highlight=${transfer.id}`,
        meta: { from: from.name, to: to.name, lines: input.items.length },
      })),
      tx
    )
    return transfer
  })
  // leída después: nada de include de varias relaciones dentro de la transacción
  return prisma.stockTransfer.findUniqueOrThrow({ where: { id }, include: detail })
}

// Pasa la transferencia de "en tránsito" a otro estado; si otra persona ya lo hizo, falla
async function closeTransfer(tx: Db, id: string, data: Prisma.StockTransferUpdateManyMutationInput & { receivedById?: string }) {
  const { count } = await tx.stockTransfer.updateMany({ where: { id, status: "IN_TRANSIT" }, data: { ...data, closedAt: new Date() } })
  if (count !== 1) throw new Error("La transferencia ya fue recibida o cancelada")
}

export async function receiveTransfer(id: string, input: z.infer<typeof receiveTransferSchema>, actor: Actor) {
  const transfer = await getTransfer(id)
  if (transfer.status !== "IN_TRANSIT") throw new Error("La transferencia ya fue recibida o cancelada")
  assertLocationAllowed(transfer.toLocationId)
  const given = new Map((input?.items ?? []).map((i) => [i.itemId, i.receivedQuantity]))
  for (const itemId of given.keys()) {
    if (!transfer.items.some((i) => i.id === itemId)) throw new Error("Alguna línea no es de esta transferencia")
  }

  const lines = transfer.items.map((item) => {
    const sent = Number(item.quantity)
    const received = given.get(item.id) ?? sent
    if (received > sent) throw new Error(`De "${item.product.name}" no pueden llegar más de ${sent}`)
    if (received > 0) assertQuantityForUnit(received, item.product.unit, `Lo recibido de "${item.product.name}"`)
    return { item, sent, received, shortage: Number(new Prisma.Decimal(sent).minus(received)) }
  })

  await prisma.$transaction(async (tx) => {
    await closeTransfer(tx, id, { status: "RECEIVED", receivedById: actor.id })
    for (const l of lines) {
      await tx.stockTransferItem.update({ where: { id: l.item.id }, data: { receivedQuantity: l.received } })
      if (l.received > 0) {
        await moveAt(tx, {
          productId: l.item.productId, locationId: transfer.toLocationId, locationName: transfer.toLocation.name, delta: l.received,
          userId: actor.id, transferId: id, reason: `Transferencia desde ${transfer.fromLocation.name}`,
          tracksLots: l.item.product.tracksLots,
          // llega lo que vence antes; lo que falta se descuenta de los últimos lotes
          lots: takeFromLots((l.item.lots ?? []) as unknown as LotMove[], l.received),
        })
      }
      // lo que no llegó deja de existir: sale del total de la empresa
      if (l.shortage > 0) {
        await tx.product.update({ where: { id: l.item.productId }, data: { stock: { decrement: l.shortage } } })
      }
    }
    const shortages = lines.filter((l) => l.shortage > 0).map((l) => ({ productId: l.item.productId, sent: l.sent, received: l.received }))
    await logAudit(actor.id, "RECEIVE", "StockTransfer", id, { shortages }, tx)
    if (transfer.sentById !== actor.id) {
      await createNotifications(
        [{
          userId: transfer.sentById, type: "transferReceived", title: transfer.toLocation.name, link: `/transfers?highlight=${id}`,
          meta: { to: transfer.toLocation.name, shortages: shortages.length },
        }],
        tx
      )
    }
  })
  return getTransfer(id)
}

export async function cancelTransfer(id: string, actor: Actor) {
  const transfer = await getTransfer(id)
  if (transfer.status !== "IN_TRANSIT") throw new Error("La transferencia ya fue recibida o cancelada")
  if (transfer.sentById !== actor.id && !actor.permissions.includes("purchases.manage")) {
    throw Object.assign(new Error("Solo quien la envió, el encargado o el administrador pueden cancelarla"), { status: 403 })
  }
  await prisma.$transaction(async (tx) => {
    await closeTransfer(tx, id, { status: "CANCELLED" })
    for (const item of transfer.items) {
      await moveAt(tx, {
        productId: item.productId, locationId: transfer.fromLocationId, locationName: transfer.fromLocation.name,
        delta: Number(item.quantity), userId: actor.id, transferId: id, reason: "Transferencia cancelada",
        tracksLots: item.product.tracksLots, lots: (item.lots ?? []) as unknown as LotMove[],
      })
    }
    await logAudit(actor.id, "UPDATE", "StockTransfer", id, { status: "CANCELLED" }, tx)
  })
  return getTransfer(id)
}

// Unidades en tránsito por producto (siguen contando en el total)
export async function inTransitByProduct(productIds: string[]) {
  const rows = await prisma.stockTransferItem.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, transfer: { status: "IN_TRANSIT", companyId: currentCompanyId() } },
    _sum: { quantity: true },
  })
  return new Map(rows.map((r) => [r.productId, Number(r._sum.quantity ?? 0)]))
}

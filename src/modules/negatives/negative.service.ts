// Negativas (decisión del usuario del 20-oct-2026): ventas de productos que el sistema tenía sin stock
// suficiente, autorizadas en la caja con el código de un encargado. Le llegan a inventario (stock.move)
// para revisarlas y resolverlas: opcionalmente con la cantidad contada (ajusta el stock de la sucursal).
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, locationScope } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { logAudit } from "../audit/audit.service.ts"
import { createMovement } from "../movements/movements.service.ts"

export const negativeListQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
})
export const resolveNegativeSchema = z.object({
  resolution: z.string().trim().min(1, "Cuenta qué se encontró o qué se hizo").max(500),
  countedQuantity: z.number().min(0).max(1e9).optional(), // cantidad real contada ahora en la sucursal
})

const detail = {
  product: { select: { id: true, name: true, sku: true, unit: true } },
  location: { select: { id: true, name: true } },
  document: { select: { id: true, consecutive: true, issuedAt: true } },
  reportedBy: { select: { id: true, name: true } },
  authorizedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
} satisfies Prisma.StockNegativeInclude

export async function listNegatives(f: z.infer<typeof negativeListQuerySchema>) {
  const scope = locationScope()
  const base: Prisma.StockNegativeWhereInput = scope ? { locationId: { in: scope } } : {}
  const where = { ...base, ...(f.status && { status: f.status }) }
  const [total, items, open] = await Promise.all([
    prisma.stockNegative.count({ where }),
    prisma.stockNegative.findMany({ where, include: detail, orderBy: { createdAt: "desc" }, ...pageArgs(f) }),
    prisma.stockNegative.count({ where: { ...base, status: "OPEN" } }),
  ])
  return { ...pageResult(items, total, f), openCount: open }
}

export async function resolveNegative(id: string, input: z.infer<typeof resolveNegativeSchema>, userId: string) {
  const negative = await prisma.stockNegative.findFirst({ where: { id }, include: { product: { select: { name: true } } } })
  if (!negative) throw Object.assign(new Error("Negativa no encontrada"), { status: 404 })
  assertLocationAllowed(negative.locationId)
  if (negative.status === "RESOLVED") throw new Error("Esta negativa ya está resuelta")

  await prisma.$transaction(async (tx) => {
    // updateMany con OPEN: dos personas resolviendo a la vez no ajustan dos veces
    const { count } = await tx.stockNegative.updateMany({
      where: { id, status: "OPEN" },
      data: {
        status: "RESOLVED", resolvedById: userId, resolvedAt: new Date(), resolution: input.resolution,
        ...(input.countedQuantity !== undefined && { countedQuantity: input.countedQuantity }),
      },
    })
    if (!count) throw new Error("Esta negativa ya está resuelta")
    if (input.countedQuantity !== undefined) {
      await createMovement(negative.productId, userId, "ADJUSTMENT", input.countedQuantity, `Negativa resuelta: ${input.resolution}`, tx, {
        source: "MANUAL", sourceId: id, locationId: negative.locationId,
      })
    }
    await logAudit(userId, "UPDATE", "StockNegative", id, { resolved: true, ...input }, tx)
  })
  return prisma.stockNegative.findFirst({ where: { id }, include: detail })
}

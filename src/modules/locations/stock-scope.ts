// Stock visto desde unas ubicaciones (la activa o las de la persona). Con "todas" se usa
// Product.stock (el total) y no hace falta nada de esto.
import { prismaRoot } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { currentCompanyId } from "../../shared/tenant.ts"

// Suma del stock de cada producto en esas ubicaciones (los que no se manejan ahí, 0)
export async function scopedStock(productIds: string[], scope: string[]) {
  const out = new Map(productIds.map((id) => [id, 0]))
  if (!productIds.length) return out
  const rows = await prismaRoot.productStock.groupBy({
    by: ["productId"],
    where: { companyId: currentCompanyId(), productId: { in: productIds }, locationId: { in: scope } },
    _sum: { quantity: true },
  })
  for (const r of rows) out.set(r.productId, Number(r._sum.quantity ?? 0))
  return out
}

// Productos que, en esas ubicaciones, están en o bajo su mínimo. Solo cuentan los que se manejan
// ahí (tienen fila de stock): un producto que nunca entró a una bodega no "falta" en ella.
export async function lowStockProductIds(scope: string[]) {
  const rows = await prismaRoot.$queryRaw<{ productId: string }[]>`
    SELECT ps."productId"
    FROM "ProductStock" ps JOIN "Product" p ON p."id" = ps."productId"
    WHERE ps."companyId" = ${currentCompanyId()} AND ps."locationId" IN (${Prisma.join(scope)}) AND p."deletedAt" IS NULL
    GROUP BY ps."productId", p."minStock"
    HAVING SUM(ps."quantity") <= p."minStock"`
  return rows.map((r) => r.productId)
}

// Reemplaza el stock total por el de esas ubicaciones en una lista de productos
export async function withScopedStock<T extends { id: string; stock: unknown }>(items: T[], scope: string[] | null) {
  if (!scope) return items
  const stock = await scopedStock(items.map((p) => p.id), scope)
  return items.map((p) => ({ ...p, stock: stock.get(p.id) ?? 0 }))
}

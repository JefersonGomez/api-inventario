// Conteo físico (Bloque 5B). Se abre en una ubicación (todos los productos o una categoría), se va
// contando de a poco (a mano o con el lector) y al cerrarlo el stock se ajusta con movimientos de
// origen COUNT. Se puede seguir vendiendo mientras dura: cada línea guarda lo que decía el sistema
// AL CONTARLA, y al cerrar se aplica solo la diferencia (contado − ese valor), así una venta hecha
// a mitad del conteo no se descuenta dos veces.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { assertLocationAllowed, currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts"
import { assertQuantityForUnit } from "../../shared/units.ts"
import { resolveLocation } from "../locations/location.service.ts"
import { createMovement } from "../movements/movements.service.ts"
import { logAudit } from "../audit/audit.service.ts"

export const createCountSchema = z.object({
  locationId: z.uuid().optional(), // sin indicar: la ubicación activa
  categoryId: z.uuid().optional(), // sin indicar: todos los productos
  notes: z.string().trim().max(500).optional(),
})
export const saveCountSchema = z.object({
  // countedQuantity null = borrar lo contado de esa línea
  items: z.array(z.object({ productId: z.uuid(), countedQuantity: z.number().min(0).nullable() })).min(1).max(500),
})
export const countListQuerySchema = z.object({ ...pageQuery, status: z.enum(["OPEN", "CLOSED", "CANCELLED"]).optional() })
export type CountListQuery = z.infer<typeof countListQuerySchema>

type Actor = { id: string }

const summaryInclude = {
  location: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
} satisfies Prisma.StockCountInclude

export async function listCounts(f: CountListQuery) {
  const scope = locationScope()
  const where: Prisma.StockCountWhereInput = {
    ...(f.status && { status: f.status }),
    ...(scope && { locationId: { in: scope } }),
  }
  const [total, items] = await Promise.all([
    prisma.stockCount.count({ where }),
    prisma.stockCount.findMany({
      where,
      include: { ...summaryInclude, _count: { select: { items: true } } },
      orderBy: { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ])
  return pageResult(items, total, f)
}

async function findCount(id: string) {
  const count = await prisma.stockCount.findFirst({ where: { id }, include: summaryInclude })
  if (!count) throw new Error("Conteo no encontrado")
  assertLocationAllowed(count.locationId)
  return count
}

// Detalle con las líneas. Para las que no se han contado se muestra el stock actual del sistema.
export async function getCount(id: string) {
  const count = await findCount(id)
  const items = await prisma.stockCountItem.findMany({
    where: { countId: id },
    include: { product: { select: { id: true, name: true, sku: true, barcode: true, unit: true, cost: true } } },
    orderBy: { product: { name: "asc" } },
  })
  const current = await prisma.productStock.findMany({
    where: { locationId: count.locationId, productId: { in: items.map((i) => i.productId) } },
    select: { productId: true, quantity: true },
  })
  const now = new Map(current.map((c) => [c.productId, Number(c.quantity)]))
  return {
    ...count,
    items: items.map((i) => ({
      ...i,
      currentQuantity: now.get(i.productId) ?? 0, // lo que dice el sistema ahora
    })),
  }
}

// Abre un conteo con todos los productos (o los de una categoría). Uno abierto por ubicación a la vez.
export async function createCount(input: z.infer<typeof createCountSchema>, actor: Actor) {
  const location = await resolveLocation(input.locationId)
  if (input.categoryId && !(await prisma.category.findFirst({ where: { id: input.categoryId, deletedAt: null } }))) {
    throw new Error("La categoría no existe")
  }
  if (await prisma.stockCount.findFirst({ where: { locationId: location.id, status: "OPEN" } })) {
    throw new Error(`Ya hay un conteo abierto en ${location.name}: ciérralo o cancélalo antes de abrir otro`)
  }
  const products = await prisma.product.findMany({
    where: { deletedAt: null, ...(input.categoryId && { categoryId: input.categoryId }) },
    select: { id: true },
  })
  if (products.length === 0) throw new Error("No hay productos para contar")

  const { id } = await prisma.$transaction(async (tx) => {
    const count = await tx.stockCount.create({
      data: {
        companyId: currentCompanyId(),
        locationId: location.id,
        categoryId: input.categoryId ?? null,
        notes: input.notes || null,
        createdById: actor.id,
      },
      select: { id: true },
    })
    await tx.stockCountItem.createMany({ data: products.map((p) => ({ countId: count.id, productId: p.id })) })
    await logAudit(actor.id, "CREATE", "StockCount", count.id, { locationId: location.id, categoryId: input.categoryId ?? null, products: products.length }, tx)
    return count
  })
  return getCount(id)
}

// Guarda lo contado (se puede ir guardando de a poco). Al contar una línea se guarda lo que dice el
// sistema en ese momento. Un producto que no estaba en la lista (encontrado en el estante) se agrega.
export async function saveCount(id: string, input: z.infer<typeof saveCountSchema>) {
  const count = await findCount(id)
  if (count.status !== "OPEN") throw new Error("El conteo ya está cerrado o cancelado")
  const ids = input.items.map((i) => i.productId)
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, unit: true } })
  if (products.length !== new Set(ids).size) throw new Error("Algún producto no existe")
  const stock = await prisma.productStock.findMany({
    where: { locationId: count.locationId, productId: { in: ids } },
    select: { productId: true, quantity: true },
  })
  const now = new Map(stock.map((s) => [s.productId, s.quantity]))

  await prisma.$transaction(async (tx) => {
    for (const item of input.items) {
      const product = products.find((p) => p.id === item.productId)!
      if (item.countedQuantity !== null) assertQuantityForUnit(item.countedQuantity, product.unit, `Lo contado de "${product.name}"`)
      const data = item.countedQuantity === null
        ? { countedQuantity: null, systemQuantity: null, countedAt: null }
        : { countedQuantity: item.countedQuantity, systemQuantity: now.get(item.productId) ?? 0, countedAt: new Date() }
      await tx.stockCountItem.upsert({
        where: { countId_productId: { countId: id, productId: item.productId } },
        create: { countId: id, productId: item.productId, ...data },
        update: data,
      })
    }
  })
  return getCount(id)
}

// Cierra: ajusta lo contado (contado − lo que decía el sistema al contarlo) con movimientos COUNT en la
// ubicación del conteo. Lo que no se contó no se toca.
export async function closeCount(id: string, actor: Actor) {
  const count = await findCount(id)
  if (count.status !== "OPEN") throw new Error("El conteo ya está cerrado o cancelado")
  const items = await prisma.stockCountItem.findMany({
    where: { countId: id, countedQuantity: { not: null } },
    include: { product: { select: { name: true } } },
  })
  if (items.length === 0) throw new Error("No hay nada contado: cuenta algún producto o cancela el conteo")

  const adjustments = items
    .map((i) => ({ item: i, delta: Number(new Prisma.Decimal(i.countedQuantity!).minus(i.systemQuantity ?? 0)) }))
    .filter((a) => a.delta !== 0)

  await prisma.$transaction(async (tx) => {
    const { count: closed } = await tx.stockCount.updateMany({
      where: { id, status: "OPEN" },
      data: { status: "CLOSED", closedById: actor.id, closedAt: new Date() },
    })
    if (closed !== 1) throw new Error("El conteo ya está cerrado o cancelado")
    for (const { item, delta } of adjustments) {
      await createMovement(
        item.productId, actor.id, delta > 0 ? "IN" : "OUT", Math.abs(delta),
        `Conteo físico: ${delta > 0 ? "sobrante" : "faltante"}`, tx,
        { source: "COUNT", sourceId: id, locationId: count.locationId }
      )
    }
    await logAudit(actor.id, "UPDATE", "StockCount", id, {
      status: "CLOSED",
      counted: items.length,
      adjustments: adjustments.map((a) => ({ productId: a.item.productId, delta: a.delta })),
    }, tx)
  })
  return getCount(id)
}

export async function cancelCount(id: string, actor: Actor) {
  await findCount(id)
  const { count } = await prisma.stockCount.updateMany({
    where: { id, status: "OPEN" },
    data: { status: "CANCELLED", closedById: actor.id, closedAt: new Date() },
  })
  if (count !== 1) throw new Error("El conteo ya está cerrado o cancelado")
  await logAudit(actor.id, "UPDATE", "StockCount", id, { status: "CANCELLED" })
  return getCount(id)
}

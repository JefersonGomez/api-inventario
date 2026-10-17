import { prisma, type Db } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import type { MovementSource, MovementType } from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { assertQuantityForUnit } from "../../shared/units.ts";
import { contains, pageArgs, pageResult } from "../../shared/pagination.ts";
import { resolveLocation } from "../locations/location.service.ts";
import { applyLots, type LotInput, type LotMove } from "../lots/lot.service.ts";
import { locationScope } from "../../shared/tenant.ts";
import type { MovementListQuery } from "./movements.schema.ts";

// Origen del movimiento: a mano por defecto; las recepciones, ventas, conteos... pasan el suyo.
// locationId: dónde ocurre (sin indicar, la ubicación activa de quien lo registra).
// lot: productos con lotes (entradas: a qué lote); lotDefault: lote a usar si no viene (p. ej. sobrante de un conteo)
export type MovementOrigin = {
  source: MovementSource;
  sourceId?: string | null;
  locationId?: string | null;
  lot?: LotInput | null | undefined;
  lotDefault?: string | undefined;
};

// Mueve el stock de un producto en una ubicación (ProductStock) y el total del producto (Product.stock)
// en la misma transacción. Entradas y salidas suman con increment (atómico): dos ventas a la vez no
// pueden dejar el stock en negativo, la segunda falla.
export async function createMovement(
  productId: string,
  userId: string,
  type: MovementType,
  quantity: number,
  reason: string | undefined,
  client: Db = prisma,
  origin: MovementOrigin = { source: "MANUAL" }
) {
  const location = await resolveLocation(origin.locationId)
  const product = await client.product.findFirst({ where: { id: productId, deletedAt: null } })
  if (!product) throw new Error("No se encontró el producto")
  assertQuantityForUnit(quantity, product.unit);

  const run = async (tx: Db) => {
    const key = { productId_locationId: { productId, locationId: location.id } };
    let delta: Prisma.Decimal;
    if (type === "ADJUSTMENT") {
      // ajuste = la cantidad contada en ESA ubicación; el total cambia por la diferencia
      const current = await tx.productStock.findUnique({ where: key, select: { quantity: true } });
      delta = new Prisma.Decimal(quantity).minus(current?.quantity ?? 0);
      await tx.productStock.upsert({
        where: key,
        create: { companyId: currentCompanyId(), productId, locationId: location.id, quantity },
        update: { quantity },
      });
    } else if (type === "IN" || type === "OUT") {
      delta = new Prisma.Decimal(type === "IN" ? quantity : -quantity);
      const row = await tx.productStock.upsert({
        where: key,
        create: { companyId: currentCompanyId(), productId, locationId: location.id, quantity: delta },
        update: { quantity: { increment: delta } },
      });
      if (row.quantity.isNegative()) throw new Error(`Stock insuficiente en ${location.name}`);
    } else {
      throw new Error("Tipo de movimiento inválido");
    }
    // productos con lotes: la entrada va a un lote; la salida toma los que vencen antes
    let lots: LotMove[] | null = null;
    if (product.tracksLots && !delta.isZero()) {
      lots = await applyLots(tx, { productId, locationId: location.id, delta: Number(delta), lot: origin.lot, defaultCode: origin.lotDefault });
    }
    const movement = await tx.stockMovement.create({
      data: {
        companyId: currentCompanyId(), productId, userId, type, quantity, reason: reason ?? null,
        source: origin.source, sourceId: origin.sourceId ?? null, locationId: location.id,
        ...(lots && { lots: lots as unknown as Prisma.InputJsonValue }),
      },
    });
    await tx.product.update({ where: { id: productId }, data: { stock: { increment: delta } } });
    return movement;
  };

  // con un tx de afuera ya estamos dentro de una transacción más grande (recepción de orden, venta…)
  return client === prisma ? prisma.$transaction(run) : run(client);
}

export async function listMovements(f: MovementListQuery) {
  const scope = locationScope();
  const where: Prisma.StockMovementWhereInput = {
    ...(scope && { locationId: { in: scope } }),
    ...(f.locationId && { AND: [{ locationId: f.locationId }] }),
    ...(f.productId && { productId: f.productId }),
    ...(f.type && { type: f.type }),
    ...(f.source && { source: f.source }),
    ...((f.from || f.to) && { createdAt: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } }),
    ...(f.q && {
      OR: [{ product: { name: contains(f.q) } }, { product: { sku: contains(f.q) } }, { reason: contains(f.q) }],
    }),
  };
  const [total, items] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({
      where,
      include: {
        product: { select: { id: true, name: true, sku: true, unit: true } },
        user: { select: { id: true, name: true, email: true } },
        location: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ]);
  return pageResult(items, total, f);
}
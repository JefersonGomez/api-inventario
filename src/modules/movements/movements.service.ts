import { prisma, type Db } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import type { MovementSource, MovementType } from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { assertQuantityForUnit } from "../../shared/units.ts";
import { contains, pageArgs, pageResult } from "../../shared/pagination.ts";
import type { MovementListQuery } from "./movements.schema.ts";

// Origen del movimiento: a mano por defecto; las recepciones, ventas, conteos... pasan el suyo
export type MovementOrigin = { source: MovementSource; sourceId?: string | null };

export async function createMovement(
  productId: string,
  userId: string,
  type: MovementType,
  quantity: number,
  reason: string | undefined,
  client: Db = prisma,
  origin: MovementOrigin = { source: "MANUAL" }
) {
  const existProduct = await client.product.findFirst({
    where: { id: productId, deletedAt: null } // ← nuevo
  })

  if (!existProduct) {
    throw new Error("No se encontró el producto")
  }

  assertQuantityForUnit(quantity, existProduct.unit);

  // aritmética con Decimal (stock con hasta 3 decimales): nada de errores de punto flotante
  let nuevoStock: Prisma.Decimal;

  switch (type) {
    case "IN":
      nuevoStock = existProduct.stock.plus(quantity);
      break;

    case "OUT":
      nuevoStock = existProduct.stock.minus(quantity);
      if (nuevoStock.isNegative()) {
        throw new Error("Stock insuficiente");
      }
      break;

    case "ADJUSTMENT":
      nuevoStock = new Prisma.Decimal(quantity);
      break;

    default:
      throw new Error("Tipo de movimiento inválido");
  }

  // ya no uses prisma.$transaction([...]) acá — cuando client === prisma
  // (uso normal, fuera de una orden de compra) seguimos queriendo atomicidad,
  // así que envolvemos con $transaction SOLO si client es el prisma global
  if (client === prisma) {
    const result = await prisma.$transaction([
      prisma.stockMovement.create({
        data: { companyId: currentCompanyId(), productId, userId, type, quantity, reason: reason ?? null, source: origin.source, sourceId: origin.sourceId ?? null }
      }),
      prisma.product.update({
        where: { id: productId },
        data: { stock: nuevoStock }
      })
    ]);
    return result[0];
  }

  // cuando viene un `tx` de afuera, ya estamos DENTRO de una transacción
  // más grande — no envolvemos de nuevo, solo ejecutamos secuencial
  const movement = await client.stockMovement.create({
    data: { companyId: currentCompanyId(), productId, userId, type, quantity, reason: reason ?? null, source: origin.source, sourceId: origin.sourceId ?? null }
  });
  await client.product.update({
    where: { id: productId },
    data: { stock: nuevoStock }
  });

  return movement;
}

export async function listMovements(f: MovementListQuery) {
  const where: Prisma.StockMovementWhereInput = {
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
      },
      orderBy: { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ]);
  return pageResult(items, total, f);
}
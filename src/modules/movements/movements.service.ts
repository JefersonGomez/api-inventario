import { prisma, type Db } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import type { MovementType } from "../../generated/prisma/enums.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
export async function createMovement(
  productId: string,
  userId: string,
  type: MovementType,
  quantity: number,
  reason: string | undefined,
  client: Db = prisma
) {
  const existProduct = await client.product.findFirst({
    where: { id: productId, deletedAt: null } // ← nuevo
  })

  if (!existProduct) {
    throw new Error("No se encontró el producto")
  }

  let nuevoStock: number;

  switch (type) {
    case "IN":
      nuevoStock = existProduct.stock + quantity;
      break;

    case "OUT":
      nuevoStock = existProduct.stock - quantity;
      if (nuevoStock < 0) {
        throw new Error("Stock insuficiente");
      }
      break;

    case "ADJUSTMENT":
      nuevoStock = quantity;
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
        data: { companyId: currentCompanyId(), productId, userId, type, quantity, reason: reason ?? null }
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
    data: { companyId: currentCompanyId(), productId, userId, type, quantity, reason: reason ?? null }
  });
  await client.product.update({
    where: { id: productId },
    data: { stock: nuevoStock }
  });

  return movement;
}

export async function getMovements(productId?: string) {
  // ✅ Solo definimos 'where' si productId tiene un valor
  const whereClause = productId ? { productId } : {};

  const movements = await prisma.stockMovement.findMany({
    where: whereClause,
    include: {
      product: true,
      user: {
        select: { id: true, name: true, email: true }
      }
    },
    orderBy: { createdAt: "desc" } // Asegúrate de que en tu schema se llame createdAt
  });

  return movements;
}
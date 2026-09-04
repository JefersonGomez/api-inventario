import { prisma } from "../../config/database.ts"
import type { MovementType } from "../../generated/prisma/enums.ts";

export async function createMovement(
  productId: string,
  userId: string,
  type: MovementType,
  quantity: number,
  reason: string | undefined
) {
  const existProduct = await prisma.product.findUnique({
    where: { id: productId }
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

  const result = await prisma.$transaction([
    prisma.stockMovement.create({
      data: {
        productId: productId,
        userId: userId,
        type: type,
        quantity: quantity,
        reason: reason ?? null
      }
    }),
    prisma.product.update({
      where: { id: productId },
      data: { stock: nuevoStock }
    })
  ])

  return result[0]; // el movimiento creado
}

export async function getMovements(productId?: string) {
  // ✅ Solo definimos 'where' si productId tiene un valor
  const whereClause = productId ? { productId } : {};

  const movements = await prisma.stockMovement.findMany({
    where: whereClause,
    include: {
      product: true,
      user: {
        select: { id: true, name: true, email: true, role: true }
      }
    },
    orderBy: { createdAt: "desc" } // Asegúrate de que en tu schema se llame createdAt
  });

  return movements;
}
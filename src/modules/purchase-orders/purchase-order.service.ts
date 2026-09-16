import { prisma } from "../../config/database.ts";
import { createMovement } from "../movements/movements.service.ts"; // ajustá el path real

export async function createPurchaseOrder(
  supplierId: string,
  createdById: string,
  items: { productId: string; quantity: number; unitCost: number }[]
) {
  return prisma.purchaseOrder.create({
    data: {
      supplierId,
      createdById,
      items: {
        create: items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitCost: i.unitCost,
        })),
      },
    },
    include: { supplier: true, items: { include: { product: true } } },
  });
}

export async function getAllPurchaseOrders() {
  return prisma.purchaseOrder.findMany({
    include: { supplier: true, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrderById(id: string) {
  return prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, items: { include: { product: true } } },
  });
}

export async function receivePurchaseOrder(id: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      throw new Error("Orden de compra no encontrada");
    }

    if (order.status !== "PENDING") {
      throw new Error("La orden ya fue recibida o cancelada");
    }

    for (const item of order.items) {
      await createMovement(
        item.productId,
        userId,
        "IN",
        item.quantity,
        `Recepción de orden de compra ${order.id}`,
        tx // ← acá está la clave: le pasamos el cliente de la transacción
      );
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: { status: "RECEIVED", receivedAt: new Date() },
      include: { supplier: true, items: { include: { product: true } } },
    });
  });
}
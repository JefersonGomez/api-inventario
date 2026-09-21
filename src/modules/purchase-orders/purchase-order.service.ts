// purchase-order.service.ts
import { prisma } from "../../config/database.ts";
import { logAudit } from "../audit/audit.service.ts";
import { createMovement } from "../movements/movements.service.ts";

export async function createPurchaseOrder(
  supplierId: string,
  createdById: string,
  items: { productId: string; quantity: number; unitCost: number }[],
  fulfilledRequestIds?: string[]
) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) {
    throw new Error("El proveedor indicado no existe");
  }

  const productIds = items.map((i) => i.productId);
  const uniqueIds = new Set(productIds);
  if (uniqueIds.size !== productIds.length) {
    throw new Error("Hay productos duplicados en las líneas de la orden");
  }

  const existingProducts = await prisma.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    select: { id: true },
  });
  if (existingProducts.length !== productIds.length) {
    const foundIds = new Set(existingProducts.map((p) => p.id));
    const missingIds = productIds.filter((id) => !foundIds.has(id));
    throw new Error(`Los siguientes productos no existen: ${missingIds.join(", ")}`);
  }

  if (fulfilledRequestIds && fulfilledRequestIds.length > 0) {
    const requests = await prisma.purchaseRequest.findMany({
      where: { id: { in: fulfilledRequestIds } },
    });

    if (requests.length !== fulfilledRequestIds.length) {
      throw new Error("Alguna de las solicitudes indicadas no existe");
    }

    const notApproved = requests.filter((r) => r.status !== "APPROVED");
    if (notApproved.length > 0) {
      throw new Error("Solo se pueden vincular solicitudes aprobadas");
    }

    const alreadyLinked = requests.filter((r) => r.purchaseOrderId !== null);
    if (alreadyLinked.length > 0) {
      throw new Error("Alguna de las solicitudes ya está vinculada a otra orden");
    }
  }

  // ← clave: guardamos el resultado en una variable, SIN "return" todavía
  const order = await prisma.purchaseOrder.create({
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
      ...(fulfilledRequestIds && fulfilledRequestIds.length > 0 && {
        fulfilledRequests: {
          connect: fulfilledRequestIds.map((id) => ({ id })),
        },
      }),
    },
    include: {
      supplier: true,
      items: { include: { product: true } },
      fulfilledRequests: true,
    },
  });

  // ahora sí se ejecuta, porque todavía no hicimos return
  await logAudit(createdById, "CREATE", "PurchaseOrder", order.id, {
    supplierId,
    items,
  });

  // el return va al final, después de todo lo que tenía que pasar antes
  return order;
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
        tx
      );
    }

    const received = await tx.purchaseOrder.update({
      where: { id },
      data: { status: "RECEIVED", receivedAt: new Date() },
      include: { supplier: true, items: { include: { product: true } } },
    });

    await logAudit(userId, "RECEIVE", "PurchaseOrder", id, undefined, tx);

    return received;
  });
}
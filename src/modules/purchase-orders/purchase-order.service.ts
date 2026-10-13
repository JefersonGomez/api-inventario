// purchase-order.service.ts
import { prisma } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { createMovement } from "../movements/movements.service.ts";
import { createNotifications } from "../notifications/notifications.persist.ts";
import { sendEmail, escapeHtml } from "../../shared/email.ts";
import { getCompany } from "../company/company.service.ts";

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
      companyId: currentCompanyId(),
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
    include: { supplier: true, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrderById(id: string) {
  return prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
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
      // Costo promedio ponderado: se calcula con el stock ANTES de que entre esta compra.
      // Sin stock o sin costo previo no hay nada que ponderar: el costo pasa a ser el de la compra.
      const before = await tx.product.findFirst({
        where: { id: item.productId, deletedAt: null },
        select: { stock: true, cost: true },
      });
      if (before) {
        const unitCost = Number(item.unitCost);
        const hasBase = before.cost !== null && before.stock > 0;
        const newCost = hasBase
          ? (before.stock * Number(before.cost) + item.quantity * unitCost) / (before.stock + item.quantity)
          : unitCost;
        await tx.product.update({ where: { id: item.productId }, data: { cost: Number(newCost.toFixed(4)) } });
      }

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
      include: { supplier: true, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
    });

    // quien pidió el producto se entera de que ya llegó (el admin que recibe no se avisa a sí mismo)
    const fulfilled = await tx.purchaseRequest.findMany({
      where: { purchaseOrderId: id, requestedById: { not: userId } },
      include: { product: true },
    });
    await createNotifications(
      fulfilled.map((r) => ({
        userId: r.requestedById,
        type: "orderReceived",
        title: r.product.name,
        meta: { quantity: r.quantity },
        link: `/purchase-requests?highlight=${r.id}`,
      })),
      tx
    );

    await logAudit(userId, "RECEIVE", "PurchaseOrder", id, undefined, tx);

    return received;
  });
}
const orderNumber = (id: string) => id.slice(0, 8).toUpperCase();

// Manda la orden al email del proveedor. Se puede reenviar: emailedAt guarda el último envío.
export async function sendPurchaseOrderEmail(id: string, userId: string) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, createdBy: { select: { name: true } }, items: { include: { product: true } } },
  });
  if (!order) throw new Error("Orden de compra no encontrada");
  if (!order.supplier.email) throw new Error("El proveedor no tiene email cargado");
  const { name: company } = await getCompany();
  if (!company) throw new Error("Configura el nombre de la empresa en Configuración antes de enviar");

  const total = order.items.reduce((sum, i) => sum + i.quantity * Number(i.unitCost), 0);
  const cell = 'style="padding:6px 10px;border-bottom:1px solid #e5e5e0"';
  const rows = order.items
    .map((i) => `<tr><td ${cell}>${escapeHtml(i.product.name)}</td><td ${cell} align="right">${i.quantity}</td>`
      + `<td ${cell} align="right">${Number(i.unitCost).toFixed(2)}</td>`
      + `<td ${cell} align="right">${(i.quantity * Number(i.unitCost)).toFixed(2)}</td></tr>`)
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1a1a18;max-width:640px">
  <h2 style="margin:0 0 4px">${escapeHtml(company)}</h2>
  <p style="margin:0 0 16px;color:#6b6b66">Orden de compra N.º ${orderNumber(order.id)}</p>
  <p>Hola ${escapeHtml(order.supplier.name)},</p>
  <p>Les enviamos la siguiente orden de compra:</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead><tr style="text-align:left;background:#f4f4ef">
      <th ${cell}>Producto</th><th ${cell} align="right">Cantidad</th><th ${cell} align="right">Costo unitario</th><th ${cell} align="right">Subtotal</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3" ${cell} align="right"><strong>Total</strong></td><td ${cell} align="right"><strong>${total.toFixed(2)}</strong></td></tr></tfoot>
  </table>
  <p style="margin-top:16px;color:#6b6b66;font-size:13px">Fecha: ${order.createdAt.toLocaleDateString("es")} · Creada por: ${escapeHtml(order.createdBy.name)}</p>
</div>`;

  const { testMode } = await sendEmail({
    to: order.supplier.email,
    subject: `Orden de compra ${orderNumber(order.id)} — ${company}`,
    html,
  });

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: { emailedAt: new Date() },
    include: { supplier: true, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
  });
  await logAudit(userId, "EMAIL", "PurchaseOrder", id, { to: order.supplier.email, testMode });
  return { order: updated, testMode };
}

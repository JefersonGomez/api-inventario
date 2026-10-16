// purchase-order.service.ts
import { prisma } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { createMovement } from "../movements/movements.service.ts";
import { resolveLocation } from "../locations/location.service.ts";
import { createNotifications } from "../notifications/notifications.persist.ts";
import { sendEmail, escapeHtml } from "../../shared/email.ts";
import { formatMoney } from "../../shared/money.ts";
import { getCompany } from "../company/company.service.ts";
import { assertQuantityForUnit, formatQuantity } from "../../shared/units.ts";
import { contains, pageArgs, pageResult } from "../../shared/pagination.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { PurchaseOrderListQuery } from "./purchase-order.schema.ts";

export async function createPurchaseOrder(
  supplierId: string,
  createdById: string,
  items: { productId: string; quantity: number; unitCost: number }[],
  fulfilledRequestIds?: string[],
  locationId?: string // a dónde entra la mercadería (sin indicar: la ubicación activa)
) {
  const location = await resolveLocation(locationId);
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
    select: { id: true, name: true, unit: true },
  });
  if (existingProducts.length !== productIds.length) {
    const foundIds = new Set(existingProducts.map((p) => p.id));
    const missingIds = productIds.filter((id) => !foundIds.has(id));
    throw new Error(`Los siguientes productos no existen: ${missingIds.join(", ")}`);
  }
  for (const p of existingProducts) {
    assertQuantityForUnit(items.find((i) => i.productId === p.id)!.quantity, p.unit, `La cantidad de "${p.name}"`);
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

  // Sin include: un create con escritura anidada corre en una transacción interna, y un include de
  // varias relaciones ahí hace que Prisma (adapter-pg) lance consultas en paralelo sobre la misma
  // conexión (aviso de pg, error en pg@9). La orden completa se lee después.
  const { id } = await prisma.purchaseOrder.create({
    data: {
      companyId: currentCompanyId(),
      supplierId,
      createdById,
      locationId: location.id,
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
    select: { id: true },
  });

  await logAudit(createdById, "CREATE", "PurchaseOrder", id, {
    supplierId,
    items,
  });

  return prisma.purchaseOrder.findUniqueOrThrow({
    where: { id },
    include: {
      supplier: true,
      location: { select: { id: true, name: true } },
      items: { include: { product: true } },
      fulfilledRequests: true,
    },
  });
}

export async function listPurchaseOrders(f: PurchaseOrderListQuery) {
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(f.status && { status: f.status }),
    ...(f.supplierId && { supplierId: f.supplierId }),
    ...(f.q && { OR: [{ supplier: { name: contains(f.q) } }, { id: { startsWith: f.q.toLowerCase() } }] }),
  };
  const [total, items] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: true, location: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ]);
  return pageResult(items, total, f);
}

export async function getPurchaseOrderById(id: string) {
  return prisma.purchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, location: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
  });
}

export async function receivePurchaseOrder(id: string, userId: string) {
  await prisma.$transaction(async (tx) => {
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
        const qty = Number(item.quantity);
        const stockBefore = Number(before.stock);
        const hasBase = before.cost !== null && stockBefore > 0;
        const newCost = hasBase
          ? (stockBefore * Number(before.cost) + qty * unitCost) / (stockBefore + qty)
          : unitCost;
        await tx.product.update({ where: { id: item.productId }, data: { cost: Number(newCost.toFixed(4)) } });
      }

      await createMovement(
        item.productId,
        userId,
        "IN",
        Number(item.quantity),
        `Recepción de orden de compra ${order.id}`,
        tx,
        { source: "PURCHASE_RECEIPT", sourceId: order.id, locationId: order.locationId }
      );
    }

    await tx.purchaseOrder.update({
      where: { id },
      data: { status: "RECEIVED", receivedAt: new Date() },
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
        meta: { quantity: r.quantity, unit: r.product.unit },
        link: `/purchase-requests?highlight=${r.id}`,
      })),
      tx
    );

    await logAudit(userId, "RECEIVE", "PurchaseOrder", id, undefined, tx);
  });

  // fuera de la transacción por lo mismo que en createPurchaseOrder (include de varias relaciones)
  return prisma.purchaseOrder.findUniqueOrThrow({
    where: { id },
    include: { supplier: true, location: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
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
  const { name: company, currency } = await getCompany();
  if (!company) throw new Error("Configura el nombre de la empresa en Configuración antes de enviar");

  const total = order.items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0);
  const cell = 'style="padding:6px 10px;border-bottom:1px solid #e5e5e0"';
  const rows = order.items
    .map((i) => `<tr><td ${cell}>${escapeHtml(i.product.name)}</td><td ${cell} align="right">${formatQuantity(Number(i.quantity), i.product.unit)}</td>`
      + `<td ${cell} align="right">${formatMoney(Number(i.unitCost), currency)}</td>`
      + `<td ${cell} align="right">${formatMoney(Number(i.quantity) * Number(i.unitCost), currency)}</td></tr>`)
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
    <tfoot><tr><td colspan="3" ${cell} align="right"><strong>Total</strong></td><td ${cell} align="right"><strong>${formatMoney(total, currency)}</strong></td></tr></tfoot>
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
    include: { supplier: true, location: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, items: { include: { product: true } } },
  });
  await logAudit(userId, "EMAIL", "PurchaseOrder", id, { to: order.supplier.email, testMode });
  return { order: updated, testMode };
}

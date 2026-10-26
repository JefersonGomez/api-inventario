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
import { Prisma } from "../../generated/prisma/client.ts";
import type { PurchaseOrderListQuery, ReceiveLine } from "./purchase-order.schema.ts";
import { createInvoice, type ReceiveInvoice } from "../payables/payables.service.ts";
import { TAX_PERCENT } from "../../shared/fiscal.ts";

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

const ORDER_INCLUDE = {
  supplier: true,
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  items: { include: { product: true } },
} as const;

// Recepción (en partes, decisión del usuario del 16-oct-2026): cada recepción anota lo que llegó por
// línea (sin items = todo lo pendiente). La orden queda PARTIAL hasta completarse (RECEIVED). Cada parte
// entra a la ubicación de la orden con su movimiento y recalcula el costo promedio con lo que llegó.
export async function receivePurchaseOrder(id: string, userId: string, lines?: ReceiveLine[], invoice?: ReceiveInvoice) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { items: { include: { product: { select: { name: true, unit: true, taxRate: true } } } } },
    });

    if (!order) {
      throw new Error("Orden de compra no encontrada");
    }

    if (order.status !== "PENDING" && order.status !== "PARTIAL") {
      throw new Error("La orden ya fue recibida, cerrada o cancelada");
    }

    const pendingOf = (item: (typeof order.items)[number]) => Number(new Prisma.Decimal(item.quantity).minus(item.receivedQuantity));
    const given = lines ? new Map(lines.map((l) => [l.itemId, l.quantity])) : null;
    const lotOf = new Map((lines ?? []).map((l) => [l.itemId, l.lot])); // productos con lotes
    if (given) {
      for (const itemId of given.keys()) {
        if (!order.items.some((i) => i.id === itemId)) throw new Error("Alguna línea no es de esta orden");
      }
    }
    const arriving = order.items
      .map((item) => ({ item, qty: given ? (given.get(item.id) ?? 0) : pendingOf(item) }))
      .filter((a) => a.qty > 0);
    if (arriving.length === 0) throw new Error("Indica qué llegó");
    for (const { item, qty } of arriving) {
      if (qty > pendingOf(item)) throw new Error(`De "${item.product.name}" solo faltan ${pendingOf(item)}`);
      assertQuantityForUnit(qty, item.product.unit, `Lo recibido de "${item.product.name}"`);
    }

    for (const { item, qty } of arriving) {
      // Costo promedio ponderado: se calcula con el stock ANTES de que entre esta parte.
      // Sin stock o sin costo previo no hay nada que ponderar: el costo pasa a ser el de la compra.
      const before = await tx.product.findFirst({
        where: { id: item.productId, deletedAt: null },
        select: { stock: true, cost: true },
      });
      if (before) {
        const unitCost = Number(item.unitCost);
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
        qty,
        `Recepción de orden de compra ${order.id}`,
        tx,
        { source: "PURCHASE_RECEIPT", sourceId: order.id, locationId: order.locationId, lot: lotOf.get(item.id) }
      );
      await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { receivedQuantity: { increment: qty } } });
    }

    const complete = order.items.every((item) => pendingOf(item) - (arriving.find((a) => a.item.id === item.id)?.qty ?? 0) <= 0);
    await tx.purchaseOrder.update({
      where: { id },
      data: complete ? { status: "RECEIVED", receivedAt: new Date() } : { status: "PARTIAL" },
    });

    // quien pidió el producto se entera de que llegó (algo o todo); el que recibe no se avisa a sí mismo
    const arrivedProducts = arriving.map((a) => a.item.productId);
    const fulfilled = await tx.purchaseRequest.findMany({
      where: { purchaseOrderId: id, requestedById: { not: userId }, productId: { in: arrivedProducts } },
      include: { product: true },
    });
    await createNotifications(
      fulfilled.map((r) => ({
        userId: r.requestedById,
        type: "orderReceived",
        title: r.product.name,
        meta: { quantity: arriving.find((a) => a.item.productId === r.productId)!.qty, unit: r.product.unit, partial: !complete },
        link: `/purchase-requests?highlight=${r.id}`,
      })),
      tx
    );

    // la factura del proveedor: sin montos, sale de lo que llegó (costo de la orden + IVA de cada producto)
    if (invoice) {
      const subtotal = arriving.reduce((s, a) => s + a.qty * Number(a.item.unitCost), 0);
      const tax = arriving.reduce((s, a) => s + a.qty * Number(a.item.unitCost) * TAX_PERCENT[a.item.product.taxRate] / 100, 0);
      await createInvoice(tx, { ...invoice, supplierId: order.supplierId, purchaseOrderId: id, subtotal: invoice.subtotal ?? subtotal, tax: invoice.tax ?? tax }, userId);
    }

    await logAudit(userId, "RECEIVE", "PurchaseOrder", id, { lines: arriving.map((a) => ({ itemId: a.item.id, quantity: a.qty })), complete }, tx);
  });

  // fuera de la transacción por lo mismo que en createPurchaseOrder (include de varias relaciones)
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
}

// Cancelar: solo si no llegó nada. Las solicitudes vinculadas vuelven a "aprobadas sin orden".
export async function cancelPurchaseOrder(id: string, userId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.purchaseOrder.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CANCELLED", cancelReason: reason },
    });
    if (count !== 1) throw new Error("Solo se cancela una orden pendiente; si ya llegó algo, ciérrala");
    await tx.purchaseRequest.updateMany({ where: { purchaseOrderId: id }, data: { purchaseOrderId: null } });
    await logAudit(userId, "UPDATE", "PurchaseOrder", id, { status: "CANCELLED", reason }, tx);
  });
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
}

// Cerrar: el proveedor ya no trae el resto. Lo pendiente se cancela; lo recibido queda.
export async function closePurchaseOrder(id: string, userId: string, reason?: string) {
  const { count } = await prisma.purchaseOrder.updateMany({
    where: { id, status: "PARTIAL" },
    data: { status: "CLOSED", receivedAt: new Date(), cancelReason: reason || null },
  });
  if (count !== 1) throw new Error("Solo se cierra una orden recibida en parte");
  await logAudit(userId, "UPDATE", "PurchaseOrder", id, { status: "CLOSED", ...(reason && { reason }) });
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
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

import * as purchaseRequestService from "../purchase-requests/purchase-request.service.ts";
import * as productService from "../products/products.service.ts";
import * as reportsService from "../reports/report.service.ts";
import { getUserNotifications } from "./notifications.persist.ts";
import { getExpiringLots } from "../lots/lot.service.ts";
import { pinStatus } from "../users/pin.service.ts";
import { needsPin } from "../../config/permissions.ts";

// `type` + `title` + `meta` son lo que consume la campanita (agrupa por tipo y arma el detalle con i18n).
// `message` se conserva como texto plano para quien no use los campos nuevos.
async function getDerivedNotifications() {

    const [expiringSoonRequests, pendingRequests, approvedUnfulfilled, expiringSoonProducts, lowStockProducts, expiringLots] = await Promise.all([
        purchaseRequestService.getExpiringSoonRequests(3),
        purchaseRequestService.getPendingRequests(),
        purchaseRequestService.getApprovedUnfulfilledRequests(),
        productService.getExpiringSoonProducts(7),
        reportsService.getLowStockReport(),
        getExpiringLots(7), // productos con lotes: avisa por lote
    ])

    // lo más agotado primero (stock/mínimo más bajo)
    const worstFirst = [...lowStockProducts].sort(
      (a, b) => Number(a.stock) / Math.max(Number(a.minStock), 1) - Number(b.stock) / Math.max(Number(b.minStock), 1)
    );

    const notifications = [
    ...expiringSoonRequests.map((r) => ({
      id: `pr-expiring-${r.id}`,
      type: "requestExpiring" as const,
      title: r.product.name,
      meta: { quantity: r.quantity, unit: r.product.unit, requester: r.requestedBy.name, expiresAt: r.expiresAt },
      message: `Solicitud de "${r.product.name}" está por vencer`,
      link: `/purchase-requests?highlight=${r.id}`,
      createdAt: r.createdAt,
    })),
    // las pendientes que ya avisan por vencer no se repiten
    ...pendingRequests
      .filter((r) => !expiringSoonRequests.some((e) => e.id === r.id))
      .map((r) => ({
        id: `pr-pending-${r.id}`,
        type: "pending" as const,
        title: r.product.name,
        meta: { quantity: r.quantity, unit: r.product.unit, requester: r.requestedBy.name },
        message: `${r.requestedBy.name} solicitó ${r.quantity} de "${r.product.name}"`,
        link: `/purchase-requests?highlight=${r.id}`,
        createdAt: r.createdAt,
      })),
    ...approvedUnfulfilled.map((r) => ({
      id: `pr-unfulfilled-${r.id}`,
      type: "approved" as const,
      title: r.product.name,
      meta: { quantity: r.quantity, unit: r.product.unit, requester: r.requestedBy.name },
      message: `Solicitud aprobada de "${r.product.name}" sin orden de compra`,
      link: `/purchase-orders?action=create&requestId=${r.id}`,
      createdAt: r.createdAt,
    })),
    ...expiringSoonProducts.map((p) => ({
      id: `product-expiring-${p.id}`,
      type: "productExpiring" as const,
      title: p.name,
      meta: { expirationDate: p.expirationDate },
      message: `"${p.name}" está por vencer`,
      link: `/products?highlight=${p.id}`,
      createdAt: p.expirationDate,
    })),
    ...expiringLots.map((l) => ({
      id: `lot-expiring-${l.id}`,
      type: "productExpiring" as const,
      title: `${l.product.name} · ${l.code}`,
      meta: { expirationDate: l.expiresAt, lot: l.code, location: l.location.name },
      message: `Lote ${l.code} de "${l.product.name}" está por vencer`,
      link: `/products?highlight=${l.product.id}`,
      createdAt: l.expiresAt,
    })),
    ...worstFirst.map((p) => ({
      id: `product-lowstock-${p.id}`,
      type: "lowStock" as const,
      title: p.name,
      meta: { stock: p.stock, minStock: p.minStock, unit: p.unit },
      message: `"${p.name}" tiene stock bajo (${p.stock}/${p.minStock})`,
      link: `/products?highlight=${p.id}`,
      createdAt: null,
    })),
  ];

  return notifications;
}

// Con purchases.manage: avisos de estado calculados + sus eventos guardados. El resto: solo sus eventos guardados.
// Los calculados no tienen estado de lectura (existen mientras el problema exista): siempre cuentan como no leídos.
export async function getNotifications(user: { id: string; permissions: string[] }) {
  const stored = (await getUserNotifications(user.id)).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    meta: n.meta,
    link: n.link,
    createdAt: n.createdAt,
    persisted: true as const,
    read: n.readAt !== null,
  }));
  const derived =
    // los avisos calculados (stock bajo, solicitudes pendientes, por vencer…) son de quien gestiona compras
    user.permissions.includes("purchases.manage")
      ? (await getDerivedNotifications()).map((n) => ({ ...n, persisted: false as const, read: false }))
      : [];

  // su código de caja: por vencer (últimos días) o vencido (no puede usar la caja hasta renovarlo)
  const code = needsPin(user.permissions) ? await pinStatus(user.id) : null;
  const codeNotice =
    code && (code.pinExpired || code.pinExpiringSoon)
      ? [{
          id: "cash-code-expiry",
          type: code.pinExpired ? ("cashCodeExpired" as const) : ("cashCodeExpiring" as const),
          title: "",
          meta: { expiresAt: code.pinExpiresAt },
          link: "/profile?tab=cash",
          createdAt: null,
          persisted: false as const,
          read: false,
        }]
      : [];

  const notifications = [...codeNotice, ...derived, ...stored];
  return {
    total: notifications.length,
    unread: notifications.filter((n) => !n.read).length,
    notifications,
  };
}

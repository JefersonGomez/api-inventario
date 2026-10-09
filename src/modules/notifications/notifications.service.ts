import * as purchaseRequestService from "../purchase-requests/purchase-request.service.ts";
import * as productService from "../products/products.service.ts";
import * as reportsService from "../reports/report.service.ts";

// `type` + `title` + `meta` son lo que consume la campanita (agrupa por tipo y arma el detalle con i18n).
// `message` se conserva como texto plano para quien no use los campos nuevos.
export async function getNotifications() {

    const [expiringSoonRequests, pendingRequests, approvedUnfulfilled, expiringSoonProducts, lowStockProducts] = await Promise.all([
        purchaseRequestService.getExpiringSoonRequests(3),
        purchaseRequestService.getPendingRequests(),
        purchaseRequestService.getApprovedUnfulfilledRequests(),
        productService.getExpiringSoonProducts(7),
        reportsService.getLowStockReport(),
    ])

    // lo más agotado primero (stock/mínimo más bajo)
    const worstFirst = [...lowStockProducts].sort(
      (a, b) => a.stock / Math.max(a.minStock, 1) - b.stock / Math.max(b.minStock, 1)
    );

    const notifications = [
    ...expiringSoonRequests.map((r) => ({
      id: `pr-expiring-${r.id}`,
      type: "requestExpiring" as const,
      title: r.product.name,
      meta: { quantity: r.quantity, requester: r.requestedBy.name, expiresAt: r.expiresAt },
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
        meta: { quantity: r.quantity, requester: r.requestedBy.name },
        message: `${r.requestedBy.name} solicitó ${r.quantity} de "${r.product.name}"`,
        link: `/purchase-requests?highlight=${r.id}`,
        createdAt: r.createdAt,
      })),
    ...approvedUnfulfilled.map((r) => ({
      id: `pr-unfulfilled-${r.id}`,
      type: "approved" as const,
      title: r.product.name,
      meta: { quantity: r.quantity, requester: r.requestedBy.name },
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
    ...worstFirst.map((p) => ({
      id: `product-lowstock-${p.id}`,
      type: "lowStock" as const,
      title: p.name,
      meta: { stock: p.stock, minStock: p.minStock },
      message: `"${p.name}" tiene stock bajo (${p.stock}/${p.minStock})`,
      link: `/products?highlight=${p.id}`,
      createdAt: null,
    })),
  ];

  return { total: notifications.length, notifications };
}

import * as purchaseRequestService from "../purchase-requests/purchase-request.service.ts";
import * as productService from "../products/products.service.ts";
import * as reportsService from "../reports/report.service.ts";



export async function getNotifications() {

    const [expiringSoonRequests, approvedUnfulfilled, expiringSoonProducts, lowStockProducts] = await Promise.all([
        purchaseRequestService.getExpiringSoonRequests(3),
        purchaseRequestService.getApprovedUnfulfilledRequests(),
        productService.getExpiringSoonProducts(7),
        reportsService.getLowStockReport(),
    ])


    const notifications = [
    ...expiringSoonRequests.map((r) => ({
      id: `pr-expiring-${r.id}`,
      message: `Solicitud de "${r.product.name}" está por vencer`,
      link: `/purchase-requests?highlight=${r.id}`,
      createdAt: r.createdAt,
    })),
    ...approvedUnfulfilled.map((r) => ({
      id: `pr-unfulfilled-${r.id}`,
      message: `Solicitud aprobada de "${r.product.name}" sin orden de compra`,
      link: `/purchase-orders?action=create&requestId=${r.id}`,
      createdAt: r.createdAt,
    })),
    ...expiringSoonProducts.map((p) => ({
      id: `product-expiring-${p.id}`,
      message: `"${p.name}" está por vencer`,
      link: `/products?highlight=${p.id}`,
      createdAt: p.expirationDate,
    })),
    ...lowStockProducts.map((p) => ({
      id: `product-lowstock-${p.id}`,
      message: `"${p.name}" tiene stock bajo (${p.stock}/${p.minStock})`,
      link: `/products?highlight=${p.id}`,
      createdAt: null,
    })),
  ];

  return { total: notifications.length, notifications };
}
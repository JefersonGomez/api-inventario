// purchase-request.service.ts
import { prisma } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import type { Role } from "../../generated/prisma/enums.ts"; // ajustá el import a como lo tengas tú
import { logAudit } from "../audit/audit.service.ts";
import { createNotifications } from "../notifications/notifications.persist.ts";
import { assertQuantityForUnit } from "../../shared/units.ts";
import { contains, pageArgs, pageResult } from "../../shared/pagination.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { PurchaseRequestListQuery } from "./purchase-request.schema.ts";
const DEFAULT_EXPIRY_DAYS = 7; 
export async function createPurchaseRequest(
  productId: string,
  requestedById: string,
  quantity: number,
  reason?: string,
  expiresAt?: Date
) {
  // ← nuevo: validar que el producto exista y no esté eliminado
  const existProduct = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
  });

  if (!existProduct) {
    throw new Error("El producto indicado no existe");
  }
  assertQuantityForUnit(quantity, existProduct.unit);

  const finalExpiresAt =
    expiresAt ??
    new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  return prisma.purchaseRequest.create({
    data: { companyId: currentCompanyId(), productId, requestedById, quantity, reason: reason ?? null, expiresAt: finalExpiresAt },
    include: { product: true, requestedBy: { select: { id: true, name: true, email: true } } },
  });
}

const requestInclude = { product: true, requestedBy: { select: { id: true, name: true, email: true } } } as const;

// quien gestiona compras ve todas; el resto, solo las suyas
type Viewer = { id: string; permissions: string[] };
const visibleTo = (user: Viewer) => (user.permissions.includes("purchases.manage") ? {} : { requestedById: user.id });

export async function listPurchaseRequests(user: Viewer, f: PurchaseRequestListQuery) {
  const where: Prisma.PurchaseRequestWhereInput = {
    ...visibleTo(user),
    ...(f.status && { status: f.status }),
    ...(f.unlinked && { status: "APPROVED", purchaseOrderId: null }),
    ...(f.q && {
      OR: [
        { product: { name: contains(f.q) } },
        { product: { sku: contains(f.q) } },
        { requestedBy: { name: contains(f.q) } },
      ],
    }),
  };
  const [total, items] = await Promise.all([
    prisma.purchaseRequest.count({ where }),
    prisma.purchaseRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: "desc" }, ...pageArgs(f) }),
  ]);
  return pageResult(items, total, f);
}

// para los enlaces ?highlight= (el resaltado puede no estar en la página actual)
export async function getPurchaseRequestById(user: Viewer, id: string) {
  const request = await prisma.purchaseRequest.findFirst({ where: { id, ...visibleTo(user) }, include: requestInclude });
  if (!request) throw new Error("Solicitud no encontrada");
  return request;
}

export async function updatePurchaseRequestStatus(
  id: string,
  status: "APPROVED" | "REJECTED",
  userId:string,
  rejectionReason?: string
) {
  const action = status === "APPROVED" ? "APPROVE" : "REJECT";

  // cambio de estado + auditoría + aviso al autor: todo o nada
  return prisma.$transaction(async (tx) => {
    const before = await tx.purchaseRequest.findUnique({ where: { id }, select: { status: true } });
    const updatedRequest = await tx.purchaseRequest.update({
      where: { id },
      // el motivo solo existe mientras esté rechazada: aprobar después lo borra
      data: { status, rejectionReason: status === "REJECTED" ? (rejectionReason ?? null) : null },
      include: { product: true, requestedBy: { select: { id: true, name: true, email: true } } },
    });

    // sin aviso si el estado no cambió (aprobar dos veces) o si el admin resolvió su propia solicitud
    if (before?.status !== status && updatedRequest.requestedById !== userId) {
      await createNotifications(
        [{
          userId: updatedRequest.requestedById,
          type: status === "APPROVED" ? "requestApproved" : "requestRejected",
          title: updatedRequest.product.name,
          meta: {
            quantity: updatedRequest.quantity,
            unit: updatedRequest.product.unit,
            ...(status === "REJECTED" && rejectionReason && { reason: rejectionReason }),
          },
          link: `/purchase-requests?highlight=${id}`,
        }],
        tx
      );
    }

    await logAudit(
      userId, action, "PurchaseRequest", id,
      status === "REJECTED" && rejectionReason ? { rejectionReason } : undefined,
      tx
    );
    return updatedRequest;
  });
}

export async function getExpiringSoonRequests(daysAhead = 3) {
  const now = new Date();
  const limit = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return prisma.purchaseRequest.findMany({
    where: {
      status: "PENDING",
      expiresAt: { gte: now, lte: limit },
    },
    include: { product: true, requestedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { expiresAt: "asc" },
  });
}

export async function getApprovedUnfulfilledRequests() {
  return prisma.purchaseRequest.findMany({
    where: {
      status: "APPROVED",
      purchaseOrderId: null,
    },
    include: { product: true, requestedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function getPendingRequests() {
  return prisma.purchaseRequest.findMany({
    where: { status: "PENDING" },
    include: { product: true, requestedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

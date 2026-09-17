// purchase-request.service.ts
import { prisma } from "../../config/database.ts";
import type { Role } from "../../generated/prisma/enums.ts"; // ajustá el import a como lo tengas tú

const DEFAULT_EXPIRY_DAYS = 7; 
export async function createPurchaseRequest(
  productId: string,
  requestedById: string,
  quantity: number,
  reason?: string,
  expiresAt?:Date
) {

   const finalExpiresAt =
    expiresAt ??
    new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  return prisma.purchaseRequest.create({
    data: { productId, requestedById, quantity, reason: reason ?? null, expiresAt: finalExpiresAt },
    include: { product: true, requestedBy: true },
  });
}

export async function getAllPurchaseRequests(user: { id: string; role: string }) {
  return prisma.purchaseRequest.findMany({
    where: user.role === "ADMIN" ? {} : { requestedById: user.id },
    include: { product: true, requestedBy: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function updatePurchaseRequestStatus(
  id: string,
  status: "APPROVED" | "REJECTED"
) {
  return prisma.purchaseRequest.update({
    where: { id },
    data: { status },
    include: { product: true, requestedBy: true },
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
    include: { product: true, requestedBy: true },
    orderBy: { expiresAt: "asc" },
  });
}

export async function getApprovedUnfulfilledRequests() {
  return prisma.purchaseRequest.findMany({
    where: {
      status: "APPROVED",
      purchaseOrderId: null,
    },
    include: { product: true, requestedBy: true },
    orderBy: { createdAt: "asc" },
  });
}
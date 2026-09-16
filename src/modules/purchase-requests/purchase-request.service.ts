// purchase-request.service.ts
import { prisma } from "../../config/database.ts";
import type { Role } from "../../generated/prisma/enums.ts"; // ajustá el import a como lo tengas tú

export async function createPurchaseRequest(
  productId: string,
  requestedById: string,
  quantity: number,
  reason?: string
) {
  return prisma.purchaseRequest.create({
    data: { productId, requestedById, quantity, reason: reason ?? null },
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
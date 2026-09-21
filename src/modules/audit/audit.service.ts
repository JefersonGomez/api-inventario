// src/modules/audit/audit.service.ts
import { prisma } from "../../config/database.ts";
import type { Prisma } from "../../generated/prisma/client.ts"; // ajustá el path si es distinto

type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "RECEIVE";

export async function logAudit(
  userId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  changes?: Prisma.InputJsonValue, // ← cambio 1: tipo correcto de Prisma, no Record<string, unknown>
  client: Prisma.TransactionClient | typeof prisma= prisma
) {
  try {
   await client.auditLog.create({
      data: {
        userId,
        action,
        entityType,
        entityId,
        ...(changes !== undefined && { changes }),
      },
    });
  } catch (error) {
    console.error("Error al registrar auditoría:", error);
  }
}

export async function getAuditLogs(entityType?: string) {
  return prisma.auditLog.findMany({
    where: entityType ? { entityType } : {},
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

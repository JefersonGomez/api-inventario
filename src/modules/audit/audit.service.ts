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

export async function getAuditMetrics() {
  const [totalCount, byAction, byEntityType, last7Days] = await Promise.all([
    prisma.auditLog.count(),

    prisma.auditLog.groupBy({
      by: ["action"],
      _count: { action: true },
    }),

    prisma.auditLog.groupBy({
      by: ["entityType"],
      _count: { entityType: true },
    }),

    // Actividad de los últimos 7 días, para un gráfico de tendencia
    prisma.auditLog.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      select: { createdAt: true },
    }),
  ]);

  // Agrupar "last7Days" por fecha (día), ya que Prisma no agrupa por día directamente
  const activityByDay: Record<string, number> = {};
  for (const log of last7Days) {
    const day = log.createdAt.toISOString().split("T")[0]!; // "2026-09-21"
    activityByDay[day] = (activityByDay[day] ?? 0) + 1;
  }

  return {
    totalCount,
    byAction: byAction.map((a) => ({ action: a.action, count: a._count.action })),
    byEntityType: byEntityType.map((e) => ({ entityType: e.entityType, count: e._count.entityType })),
    activityByDay, // { "2026-09-15": 3, "2026-09-16": 7, ... }
 
  };
}

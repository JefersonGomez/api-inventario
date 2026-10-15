// src/modules/audit/audit.service.ts
import { prisma, type Db } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";

import type { Prisma } from "../../generated/prisma/client.ts"; // ajustá el path si es distinto
import { z } from "zod";
import { contains, pageArgs, pageQuery, pageResult } from "../../shared/pagination.ts";

type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "RECEIVE"  | "ACTIVATE" | "DEACTIVATE" | "EMAIL";

export async function logAudit(
  userId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  changes?: Prisma.InputJsonValue, // ← cambio 1: tipo correcto de Prisma, no Record<string, unknown>
  client: Db = prisma
) {
  try {
   await client.auditLog.create({
      data: {
        companyId: currentCompanyId(),
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

// GET /audit-logs: más recientes primero (antes: los últimos 200 sin paginar)
export const auditListQuerySchema = z.object({
  ...pageQuery,
  entityType: z.string().max(60).optional(),
  action: z.string().max(30).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export async function listAuditLogs(f: AuditListQuery) {
  const where: Prisma.AuditLogWhereInput = {
    ...(f.entityType && { entityType: f.entityType }),
    ...(f.action && { action: f.action }),
    ...((f.from || f.to) && { createdAt: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } }),
    ...(f.q && { OR: [{ user: { name: contains(f.q) } }, { entityId: { startsWith: f.q } }] }),
  };
  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      ...pageArgs(f),
    }),
  ]);
  return pageResult(items, total, f);
}

export async function getAuditMetrics() {
  const [totalCount, byAction, byEntityType, last7Days, emailTotal, emailTest, lastEmail] = await Promise.all([
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
      orderBy: { createdAt: "asc" },
    }),

    // correos de órdenes enviados a proveedores (acción EMAIL)
    prisma.auditLog.count({ where: { action: "EMAIL" } }),
    prisma.auditLog.count({ where: { action: "EMAIL", changes: { path: ["testMode"], equals: true } } }),
    prisma.auditLog.findFirst({
      where: { action: "EMAIL" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, changes: true, user: { select: { name: true } } },
    }),
  ]);

  return {
    totalCount,
    byAction: byAction.map((a) => ({ action: a.action, count: a._count.action })),
    byEntityType: byEntityType.map((e) => ({ entityType: e.entityType, count: e._count.entityType })),
    // ponytail: timestamps crudos para que el cliente agrupe por día en su zona horaria; agregar por día en SQL si crece mucho
    recentActivity: last7Days.map((l) => l.createdAt),
    emails: { total: emailTotal, testMode: emailTest, last: lastEmail },
  };
}

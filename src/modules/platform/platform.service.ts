// Panel del dueño de la plataforma: ve todas las empresas (nombre, dueño, plan, uso y estado)
// y puede cambiar el plan o suspenderlas. NO expone datos de inventario de los clientes.
import { prismaRoot } from "../../config/database.ts";
import { PLANS } from "../../config/plans.ts";
import { runWithCompany } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { getAiBudget, setAiBudget } from "../ai/ai.service.ts";
import type { Prisma } from "../../generated/prisma/client.ts";

export async function listCompanies() {
  const [companies, members, products] = await Promise.all([
    prismaRoot.company.findMany({
      include: { owner: { select: { id: true, name: true, email: true, plan: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prismaRoot.membership.groupBy({ by: ["companyId"], where: { isActive: true }, _count: { _all: true } }),
    prismaRoot.product.groupBy({ by: ["companyId"], where: { deletedAt: null }, _count: { _all: true } }),
  ]);
  const usersBy = new Map(members.map((m) => [m.companyId, m._count._all]));
  const productsBy = new Map(products.map((p) => [p.companyId, p._count._all]));

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    currency: c.currency,
    createdAt: c.createdAt,
    suspendedAt: c.suspendedAt,
    suspensionReason: c.suspensionReason,
    owner: { id: c.owner.id, name: c.owner.name, email: c.owner.email },
    plan: c.owner.plan,
    limits: PLANS[c.owner.plan],
    users: usersBy.get(c.id) ?? 0,
    products: productsBy.get(c.id) ?? 0,
  }));
}

// El plan es de la cuenta del dueño: cambia el de todas sus empresas.
export async function setPlan(companyId: string, plan: "BASIC" | "PRO" | "BUSINESS", byUserId: string) {
  const company = await prismaRoot.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
  if (!company) throw new Error("Empresa no encontrada");
  await prismaRoot.user.update({ where: { id: company.ownerId }, data: { plan } });
  await runWithCompany(companyId, () => logAudit(byUserId, "UPDATE", "Company", companyId, { plan, by: "platform" }));
}

export async function setSuspended(companyId: string, suspended: boolean, reason: string | undefined, byUserId: string) {
  const exists = await prismaRoot.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!exists) throw new Error("Empresa no encontrada");
  await prismaRoot.company.update({
    where: { id: companyId },
    data: suspended
      ? { suspendedAt: new Date(), suspensionReason: reason || null }
      : { suspendedAt: null, suspensionReason: null },
  });
  await runWithCompany(companyId, () =>
    logAudit(byUserId, "UPDATE", "Company", companyId, { suspended, ...(reason && { reason }), by: "platform" })
  );
}

const DAY = 24 * 60 * 60 * 1000;

// Actividad de cada empresa (Bloque 6A): última entrada de alguien (último inicio o renovación de sesión),
// movimientos de la última semana y el último. Solo números: ningún dato de inventario del cliente.
// Ventas de la semana: cuando exista el POS (Bloque 7).
export async function companyActivity() {
  const weekAgo = new Date(Date.now() - 7 * DAY);
  const [sessions, moves, lastMoves] = await Promise.all([
    prismaRoot.refreshToken.groupBy({ by: ["companyId"], _max: { createdAt: true } }),
    prismaRoot.stockMovement.groupBy({ by: ["companyId"], where: { createdAt: { gte: weekAgo } }, _count: { _all: true } }),
    prismaRoot.stockMovement.groupBy({ by: ["companyId"], _max: { createdAt: true } }),
  ]);
  const last = new Map(sessions.map((s) => [s.companyId, s._max.createdAt]));
  const week = new Map(moves.map((m) => [m.companyId, m._count._all]));
  const lastMove = new Map(lastMoves.map((m) => [m.companyId, m._max.createdAt]));
  const companies = await prismaRoot.company.findMany({ select: { id: true }, orderBy: { createdAt: "desc" } });
  return companies.map((c) => ({
    companyId: c.id,
    lastSeenAt: last.get(c.id) ?? null,
    movementsWeek: week.get(c.id) ?? 0,
    lastMovementAt: lastMove.get(c.id) ?? null,
  }));
}

// Empresas nuevas por semana (las últimas 12 semanas, la más vieja primero)
export async function signupsByWeek(weeks = 12) {
  const now = new Date();
  // inicio de la semana actual (lunes, UTC)
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const from = new Date(monday.getTime() - (weeks - 1) * 7 * DAY);
  const created = await prismaRoot.company.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } });
  return Array.from({ length: weeks }, (_, i) => {
    const start = new Date(from.getTime() + i * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    return { weekStart: start, count: created.filter((c) => c.createdAt >= start && c.createdAt < end).length };
  });
}

// Medidor de IA del mes (o de "AAAA-MM"): gasto por empresa y por función, total y presupuesto
export async function aiUsageReport(month?: string) {
  const [y, m] = (month ?? new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 1));
  const where = { createdAt: { gte: start, lt: end } };
  const [byCompany, byFeature, totals, budget, companies] = await Promise.all([
    prismaRoot.aiUsage.groupBy({ by: ["companyId", "feature"], where, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
    prismaRoot.aiUsage.groupBy({ by: ["feature"], where, _count: { _all: true }, _sum: { costUsd: true } }),
    prismaRoot.aiUsage.aggregate({ where, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
    getAiBudget(),
    prismaRoot.company.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(companies.map((c) => [c.id, c.name]));
  const rows = new Map<string, { companyId: string | null; name: string; calls: Record<string, number>; costUsd: number; tokens: number }>();
  for (const r of byCompany) {
    const key = r.companyId ?? "none";
    const row = rows.get(key) ?? { companyId: r.companyId, name: r.companyId ? (names.get(r.companyId) ?? "—") : "—", calls: {}, costUsd: 0, tokens: 0 };
    row.calls[r.feature] = r._count._all;
    row.costUsd += Number(r._sum.costUsd ?? 0);
    row.tokens += (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0);
    rows.set(key, row);
  }
  const spent = Number(totals._sum.costUsd ?? 0);
  return {
    month: start.toISOString().slice(0, 7),
    spentUsd: Number(spent.toFixed(4)),
    calls: totals._count._all,
    tokens: (totals._sum.inputTokens ?? 0) + (totals._sum.outputTokens ?? 0),
    budget: { monthlyUsd: budget.monthlyUsd, alertPercent: budget.alertPercent },
    paused: spent >= budget.monthlyUsd,
    byFeature: byFeature.map((f) => ({ feature: f.feature, calls: f._count._all, costUsd: Number(Number(f._sum.costUsd ?? 0).toFixed(4)) })),
    byCompany: [...rows.values()].map((r) => ({ ...r, costUsd: Number(r.costUsd.toFixed(4)) })).sort((a, b) => b.costUsd - a.costUsd),
  };
}

// Registro propio de acciones del dueño: lo que hizo desde el panel (planes, suspensiones), en todas las empresas
export async function ownerActions(limit = 100) {
  const logs = await prismaRoot.auditLog.findMany({
    where: { changes: { path: ["by"], equals: "platform" } },
    include: { user: { select: { name: true } }, company: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return logs.map((l) => ({ id: l.id, createdAt: l.createdAt, user: l.user?.name ?? "—", company: l.company?.name ?? "—", changes: l.changes }));
}

export { setAiBudget };

// acción del dueño sobre la plataforma (no sobre una empresa): queda en su registro de acciones
export const logPlatformAction = (userId: string, key: string, changes: Record<string, unknown>) =>
  logAudit(userId, "UPDATE", "PlatformSetting", key, { ...changes, by: "platform" } as Prisma.InputJsonValue);

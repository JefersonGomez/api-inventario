// Suscripciones vistas por el dueño de la plataforma (C5): todas las cuentas con su estado, lo que pagan,
// los ingresos del mes y los últimos pagos. Herramientas de soporte: regalar días y marcar cuenta interna.
import { prismaRoot as prisma } from "../../config/database.ts";
import { runWithCompany } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { billingEnabled, ensureSubscription } from "./billing.service.ts";
import { subscriptionState } from "./billing.state.ts";
import { amountFor } from "./payments.service.ts";
import { platformCompanyId } from "./subscription-invoice.service.ts";

const DAY = 24 * 60 * 60 * 1000;

export async function listSubscriptions(now = new Date()) {
  const owners = await prisma.user.findMany({
    where: { isPlatformOwner: false, ownedCompanies: { some: {} } },
    select: {
      id: true, name: true, email: true, plan: true, isDemo: true,
      ownedCompanies: { select: { name: true }, orderBy: { createdAt: "asc" } },
      subscription: { include: { payments: { orderBy: { createdAt: "desc" }, take: 1 } } },
    },
    orderBy: { createdAt: "desc" },
  });
  const rows = owners.map((u) => {
    const sub = u.subscription;
    const st = u.isDemo || !sub ? null : subscriptionState(sub, now);
    const state = u.isDemo ? "exempt" : st?.state ?? "none"; // none = todavía no empezó (cobro apagado)
    const last = sub?.payments[0];
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      companies: u.ownedCompanies.map((c) => c.name),
      plan: u.plan,
      interval: sub?.interval ?? "MONTHLY",
      state,
      endsAt: st?.endsAt ?? null,
      daysLeft: st?.daysLeft ?? null,
      method: !sub ? null : sub.paymentMethodId ? `${sub.cardBrand ?? "Tarjeta"} ••${sub.cardLast4 ?? ""}` : last?.method === "SINPE" ? "SINPE Móvil" : null,
      nextPlan: sub?.nextPlan ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      exempt: sub?.exempt ?? false,
      isDemo: u.isDemo,
      lastPayment: last ? { status: last.status, amount: last.amount, at: last.paidAt ?? last.createdAt } : null,
    };
  });
  // ingreso mensual recurrente: lo que pagan por mes las cuentas al día (anual / 12)
  const mrr = rows
    .filter((r) => r.state === "active")
    .reduce((sum, r) => sum + Math.round(amountFor(r.plan, r.interval) / (r.interval === "ANNUAL" ? 12 : 1)), 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = await prisma.subscriptionPayment.aggregate({
    where: { status: "SUCCEEDED", paidAt: { gte: monthStart } },
    _sum: { amount: true },
    _count: true,
  });
  const recent = await prisma.subscriptionPayment.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { subscription: { select: { user: { select: { name: true, email: true } } } } },
  });
  const count = (s: string) => rows.filter((r) => r.state === s).length;
  return {
    enabled: billingEnabled(),
    invoicing: !!platformCompanyId(), // C6: hay empresa emisora configurada
    totals: { mrr, monthRevenue: month._sum.amount ?? 0, monthPayments: month._count, active: count("active"), trial: count("trial"), grace: count("grace"), expired: count("expired") },
    subscriptions: rows,
    payments: recent.map((p) => ({
      id: p.id, owner: p.subscription.user.name, email: p.subscription.user.email, amount: p.amount, method: p.method, kind: p.kind,
      plan: p.plan, interval: p.interval, status: p.status, automatic: p.automatic, failureMessage: p.failureMessage, at: p.paidAt ?? p.createdAt,
      invoice: p.documentId ? "OK" : p.status === "SUCCEEDED" ? (p.invoiceError ? "ERROR" : "PENDING") : null, invoiceError: p.invoiceError,
    })),
  };
}

// Soporte: regalar días (a la prueba o al periodo pagado) y marcar cuenta interna (nunca vence)
export async function adminUpdateSubscription(userId: string, input: { extendDays?: number; exempt?: boolean }, byUserId: string, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, ownedCompanies: { select: { id: true }, take: 1 } } });
  if (!user) throw Object.assign(new Error("Cuenta no encontrada"), { status: 404 });
  const sub = await ensureSubscription(userId);
  const data: { exempt?: boolean; paidUntil?: Date; trialEndsAt?: Date } = {};
  if (input.exempt !== undefined) data.exempt = input.exempt;
  if (input.extendDays) {
    const add = input.extendDays * DAY;
    if (sub.paidUntil && sub.paidUntil > now) data.paidUntil = new Date(sub.paidUntil.getTime() + add);
    else data.trialEndsAt = new Date(Math.max(sub.trialEndsAt.getTime(), sub.paidUntil?.getTime() ?? 0, now.getTime()) + add);
  }
  await prisma.subscription.update({ where: { id: sub.id }, data });
  const companyId = user.ownedCompanies[0]?.id;
  if (companyId) await runWithCompany(companyId, () => logAudit(byUserId, "UPDATE", "Subscription", sub.id, { ...input, by: "platform" }));
}

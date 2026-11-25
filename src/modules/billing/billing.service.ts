// Suscripción de la cuenta (fase de cobro). C1: prueba gratis, elegir plan/periodo y solo lectura al vencer.
// Todo se enciende con BILLING_ENABLED=1; apagado, la app funciona como siempre (nadie vence).
// Usa prismaRoot: la suscripción es de la cuenta del dueño, no de una empresa.
import { prismaRoot as prisma } from "../../config/database.ts";
import { BILLING, PRICES } from "../../config/plans.ts";
import type { BillingInterval, PlanCode } from "../../generated/prisma/enums.ts";
import { logAudit } from "../audit/audit.service.ts";
import { subscriptionState, trialEnd, type SubscriptionDates } from "./billing.state.ts";
import { onvoConfigured } from "./onvo.client.ts";

type HttpError = Error & { status?: number; code?: string };
const fail = (message: string, status: number, code: string): HttpError => Object.assign(new Error(message), { status, code });

export const billingEnabled = () => process.env.BILLING_ENABLED === "1";

// La primera vez que se mira una cuenta sin suscripción (cuentas de antes del cobro) empieza su prueba ahí.
export function ensureSubscription(userId: string) {
  return prisma.subscription.upsert({ where: { userId }, update: {}, create: { userId, trialEndsAt: trialEnd() } });
}

const DEMO: SubscriptionDates = { trialEndsAt: new Date(0), paidUntil: null, exempt: true };

// Estado de la cuenta del dueño de una empresa (lo usa el middleware en cada petición)
export async function ownerState(owner: { id: string; isDemo: boolean; subscription: SubscriptionDates | null }) {
  if (owner.isDemo) return subscriptionState(DEMO);
  return subscriptionState(owner.subscription ?? (await ensureSubscription(owner.id)));
}

export async function getSubscription(companyId: string, viewerId: string) {
  const { ownerId, owner } = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { ownerId: true, owner: { select: { name: true, plan: true, isDemo: true, subscription: true } } },
  });
  const base = {
    enabled: billingEnabled(),
    isOwner: ownerId === viewerId,
    ownerName: owner.name,
    plan: owner.plan,
    prices: PRICES,
    trialDays: BILLING.trialDays,
    graceDays: BILLING.graceDays,
  };
  if (!base.enabled) return base;
  const sub = owner.isDemo ? { ...DEMO, interval: "MONTHLY" as BillingInterval } : owner.subscription ?? (await ensureSubscription(ownerId));
  const card = "cardLast4" in sub && sub.cardLast4 ? { brand: sub.cardBrand, last4: sub.cardLast4 } : null;
  return {
    ...base,
    interval: sub.interval,
    trialEndsAt: sub.trialEndsAt,
    paidUntil: sub.paidUntil,
    ...subscriptionState(sub),
    cardPayments: onvoConfigured(), // el servidor tiene las llaves de ONVO (C2)
    card, // tarjeta guardada para renovar (solo marca y últimos 4)
  };
}

// El dueño elige plan y periodo (mensual / anual) mientras no tenga un periodo pagado vigente.
// Con uno pagado, cambiar de plan es la fase C5 (prorrateo).
export async function updateSubscription(companyId: string, viewerId: string, input: { plan?: PlanCode; interval?: BillingInterval }) {
  const { ownerId, owner } = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { ownerId: true, owner: { select: { isDemo: true, subscription: true } } },
  });
  if (ownerId !== viewerId) throw fail("Solo el dueño de la cuenta puede cambiar el plan", 403, "BILLING_OWNER_ONLY");
  if (owner.isDemo) throw fail("La demo no cambia de plan", 403, "BILLING_DEMO");
  const sub = owner.subscription ?? (await ensureSubscription(ownerId));
  if (subscriptionState(sub).state === "active") {
    throw fail("Ya tienes un periodo pagado: el cambio de plan con pago llega pronto. Escríbenos a hola@cubivo.org", 409, "BILLING_PAID_CHANGE");
  }
  if (input.plan) await prisma.user.update({ where: { id: ownerId }, data: { plan: input.plan } });
  if (input.interval) await prisma.subscription.update({ where: { userId: ownerId }, data: { interval: input.interval } });
  await logAudit(viewerId, "UPDATE", "Subscription", sub.id, { ...input });
  return getSubscription(companyId, viewerId);
}

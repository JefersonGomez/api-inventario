// Estado de una suscripción, calculado solo con fechas (sin tareas programadas):
// exempt  → cuenta interna o demo, nunca vence
// active  → tiene un periodo pagado vigente (paidUntil en el futuro)
// trial   → dentro de la prueba gratis
// grace   → venció (prueba o periodo pagado) hace menos de BILLING.graceDays: todo sigue funcionando, con aviso
// expired → pasaron los días de gracia: la cuenta queda en SOLO LECTURA (ver y exportar, no vender ni facturar)
import { BILLING } from "../../config/plans.ts";

export type BillingState = "exempt" | "active" | "trial" | "grace" | "expired";
export type SubscriptionDates = { trialEndsAt: Date; paidUntil: Date | null; exempt: boolean };

const DAY = 24 * 60 * 60 * 1000;

export function subscriptionState(sub: SubscriptionDates, now = new Date()) {
  if (sub.exempt) return { state: "exempt" as BillingState, endsAt: null, graceEndsAt: null, daysLeft: null };
  const paid = sub.paidUntil && sub.paidUntil > now
  if (paid) return { state: "active" as BillingState, endsAt: sub.paidUntil, graceEndsAt: null, daysLeft: daysUntil(sub.paidUntil!, now) };
  if (sub.trialEndsAt > now) return { state: "trial" as BillingState, endsAt: sub.trialEndsAt, graceEndsAt: null, daysLeft: daysUntil(sub.trialEndsAt, now) };
  // venció: lo último que tenía (prueba o periodo pagado) + los días de gracia
  const ended = sub.paidUntil && sub.paidUntil > sub.trialEndsAt ? sub.paidUntil : sub.trialEndsAt;
  const graceEndsAt = new Date(ended.getTime() + BILLING.graceDays * DAY);
  if (graceEndsAt > now) return { state: "grace" as BillingState, endsAt: ended, graceEndsAt, daysLeft: daysUntil(graceEndsAt, now) };
  return { state: "expired" as BillingState, endsAt: ended, graceEndsAt, daysLeft: 0 };
}

// días que faltan, redondeando hacia arriba (quedan 2 h → "1 día")
const daysUntil = (d: Date, now: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY));

export const trialEnd = (from = new Date()) => new Date(from.getTime() + BILLING.trialDays * DAY);

// Renovación y cobranza (C4). Corre cada hora en el servidor (server.ts), solo con BILLING_ENABLED=1:
// 1. pagos que quedaron esperando (3DS o SINPE): se consultan; si pasan 24 h sin terminar se cancelan en ONVO
// 2. tarjeta guardada: al llegar el vencimiento se cobra sola (hasta 3 intentos, uno por día, dentro de la gracia);
//    si el banco pide 3DS, le llega al dueño un correo con el enlace para confirmar
// 3. correos: la prueba termina en 3 días, recordatorio de renovación a quien paga por SINPE, cuenta en solo lectura
// Cada correo sale una sola vez (BillingNotice); un fallo con una cuenta no detiene a las demás.
import { prismaRoot as prisma } from "../../config/database.ts";
import { BILLING } from "../../config/plans.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { billingEnabled } from "./billing.service.ts";
import { subscriptionState } from "./billing.state.ts";
import * as mail from "./billing-email.ts";
import * as onvo from "./onvo.client.ts";
import { amountFor, applyIntent } from "./payments.service.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 3;
const appUrl = () => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Marca el aviso como enviado; false si ya se había mandado (clave única por suscripción)
async function claimNotice(subscriptionId: string, key: string) {
  try {
    await prisma.billingNotice.create({ data: { subscriptionId, key } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

// Manda el correo una sola vez; si el envío falla, se borra la marca para reintentar en la próxima vuelta
async function notifyOnce(subscriptionId: string, key: string, send: () => Promise<unknown>) {
  if (!(await claimNotice(subscriptionId, key))) return;
  try {
    await send();
  } catch (err) {
    await prisma.billingNotice.deleteMany({ where: { subscriptionId, key } });
    throw err;
  }
}

const safe = async (what: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    console.error(`cobro (${what}):`, (err as Error).message);
  }
};

export async function processBilling(now = new Date()) {
  if (!billingEnabled()) return;
  await settlePending(now);
  if (onvo.onvoConfigured()) await chargeDueCards(now);
  await sendNotices(now);
}

// 1. pagos pendientes de hace más de 10 minutos (el dueño cerró la página): se le pregunta a ONVO
async function settlePending(now: Date) {
  const stale = await prisma.subscriptionPayment.findMany({
    where: { status: "PENDING", onvoIntentId: { not: null }, createdAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
    take: 100,
  });
  for (const p of stale) {
    await safe(`pendiente ${p.id}`, async () => {
      const intent = await onvo.getIntent(p.onvoIntentId!);
      const result = await applyIntent(p.id, intent);
      if (result.status === "PENDING" && now.getTime() - p.createdAt.getTime() > DAY) {
        // nadie lo terminó en 24 h: se cancela en ONVO para que ya no acepte una transferencia tardía
        await onvo.cancelIntent(p.onvoIntentId!);
        await prisma.subscriptionPayment.updateMany({
          where: { id: p.id, status: "PENDING" },
          data: { status: "FAILED", failureMessage: p.method === "SINPE" ? "No llegó la transferencia a tiempo" : "No se completó la verificación del banco" },
        });
      }
    });
  }
}

// 2. renovación con la tarjeta guardada
async function chargeDueCards(now: Date) {
  const due = await prisma.subscription.findMany({
    where: {
      exempt: false,
      cancelAtPeriodEnd: false,
      paymentMethodId: { not: null },
      onvoCustomerId: { not: null },
      // vence en las próximas 6 horas o ya venció, pero todavía dentro de la gracia
      paidUntil: { lte: new Date(now.getTime() + 6 * HOUR), gt: new Date(now.getTime() - BILLING.graceDays * DAY) },
      user: { isDemo: false, isActive: true },
    },
    include: { user: { select: { name: true, email: true, plan: true } } },
    take: 100,
  });
  for (const sub of due) {
    await safe(`renovar ${sub.id}`, async () => {
      // intentos automáticos de ESTE vencimiento (desde un día antes)
      const attempts = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: sub.id, automatic: true, createdAt: { gte: new Date(sub.paidUntil!.getTime() - DAY) } },
        orderBy: { createdAt: "desc" },
      });
      if (attempts.some((a) => a.status === "PENDING" || a.status === "SUCCEEDED")) return;
      if (attempts.length >= MAX_ATTEMPTS) return;
      if (attempts[0] && now.getTime() - attempts[0].createdAt.getTime() < DAY) return; // un intento por día
      const anyPending = await prisma.subscriptionPayment.count({ where: { subscriptionId: sub.id, status: "PENDING" } });
      if (anyPending) return;

      // lo programado (bajar de plan o cambiar de periodo) rige desde esta renovación
      const plan = sub.nextPlan ?? sub.user.plan;
      const interval = sub.nextInterval ?? sub.interval;
      const amount = amountFor(plan, interval);
      const payment = await prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id, method: "CARD", automatic: true, plan, interval, amount,
          paymentMethodId: sub.paymentMethodId, cardBrand: sub.cardBrand, cardLast4: sub.cardLast4,
        },
      });
      const card = sub.cardLast4 ? `${sub.cardBrand ?? ""} terminada en ${sub.cardLast4}`.trim() : null;
      try {
        const intent = await onvo.createIntent({
          amount: amount * 100,
          customerId: sub.onvoCustomerId!,
          description: `Cubivo plan ${plan} ${interval === "ANNUAL" ? "anual" : "mensual"} (renovación)`,
          metadata: { paymentId: payment.id, userId: sub.userId, plan, interval, automatic: "1" },
        });
        await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { onvoIntentId: intent.id } });
        const confirmed = await onvo.confirmIntent(intent.id, {
          paymentMethodId: sub.paymentMethodId!,
          returnUrl: `${appUrl()}/subscription?payment=${payment.id}`,
        });
        const result = await applyIntent(payment.id, confirmed);
        if (result.status === "PENDING" && confirmed.nextAction?.redirectToUrl?.url) {
          await mail.confirmChargeEmail(sub.user, amount, confirmed.nextAction.redirectToUrl.url);
        } else if (result.status === "FAILED") {
          await mail.chargeFailedEmail(sub.user, amount, card, attempts.length + 1 < MAX_ATTEMPTS);
        }
      } catch (err) {
        await prisma.subscriptionPayment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: { status: "FAILED", failureMessage: (err as Error).message.slice(0, 300) },
        });
        throw err;
      }
    });
  }
}

// 3. avisos por correo
async function sendNotices(now: Date) {
  const soon = new Date(now.getTime() + 3 * DAY);
  const subs = await prisma.subscription.findMany({
    where: {
      exempt: false,
      user: { isDemo: false, isActive: true },
      OR: [
        { paidUntil: null, trialEndsAt: { lte: soon, gt: new Date(now.getTime() - 30 * DAY) } },
        { paidUntil: { lte: soon, gt: new Date(now.getTime() - 30 * DAY) } },
      ],
    },
    include: { user: { select: { name: true, email: true, plan: true } } },
    take: 500,
  });
  for (const sub of subs) {
    await safe(`avisos ${sub.id}`, async () => {
      const { state, endsAt } = subscriptionState(sub, now);
      if (state === "trial" && !sub.paidUntil && endsAt) {
        await notifyOnce(sub.id, `trial-ending:${iso(endsAt)}`, () => mail.trialEndingEmail(sub.user, sub.user.plan, endsAt));
      }
      // sin tarjeta guardada (paga por SINPE): recordatorio 3 días antes de vencer el periodo pagado
      if (state === "active" && sub.paidUntil && !sub.paymentMethodId && !sub.cancelAtPeriodEnd && endsAt) {
        const plan = sub.nextPlan ?? sub.user.plan;
        const amount = amountFor(plan, sub.nextInterval ?? sub.interval);
        await notifyOnce(sub.id, `renew-reminder:${iso(endsAt)}`, () => mail.renewalReminderEmail(sub.user, plan, amount, endsAt));
      }
      if (state === "expired" && endsAt) {
        await notifyOnce(sub.id, `expired:${iso(endsAt)}`, () => mail.expiredEmail(sub.user));
      }
    });
  }
}

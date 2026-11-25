// Pago de la suscripción con tarjeta (C2), con ONVO:
// 1. GET /billing/card-setup → el navegador recibe la llave pública y el cliente de ONVO de la cuenta
// 2. el navegador registra la tarjeta en ONVO (nunca pasa por acá) y manda solo su id
// 3. POST /billing/pay { paymentMethodId } → se cobra el plan y periodo elegidos
//    - aprobado: el periodo se aplica al instante
//    - el banco pide verificar (3DS): se devuelve la URL; al volver, POST /billing/payments/:id/sync
// El periodo se aplica una sola vez (applyPayment es idempotente): el webhook de producción (C7) usa lo mismo.
import { prismaRoot as prisma } from "../../config/database.ts";
import { PRICES } from "../../config/plans.ts";
import type { BillingInterval, PlanCode } from "../../generated/prisma/enums.ts";
import { logAudit } from "../audit/audit.service.ts";
import { billingEnabled, ensureSubscription } from "./billing.service.ts";
import * as onvo from "./onvo.client.ts";

type HttpError = Error & { status?: number; code?: string };
const fail = (message: string, status: number, code: string): HttpError => Object.assign(new Error(message), { status, code });

const appUrl = () => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

export const amountFor = (plan: PlanCode, interval: BillingInterval) =>
  interval === "ANNUAL" ? PRICES[plan].annual * 12 : PRICES[plan].monthly;

// suma un mes o un año sin pasarse de fin de mes (31-ene + 1 mes = 28/29-feb)
export function addPeriod(from: Date, interval: BillingInterval) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (interval === "ANNUAL" ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// Dueño de la empresa activa que va a pagar (no la demo, no una cuenta interna, cobro encendido)
async function payer(companyId: string, viewerId: string) {
  if (!billingEnabled()) throw fail("El cobro no está activo", 409, "BILLING_DISABLED");
  if (!onvo.onvoConfigured()) throw fail("El cobro con tarjeta no está configurado en el servidor", 503, "ONVO_NOT_CONFIGURED");
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { ownerId: true, owner: { select: { name: true, email: true, plan: true, isDemo: true } } },
  });
  if (company.ownerId !== viewerId) throw fail("Solo el dueño de la cuenta puede pagar", 403, "BILLING_OWNER_ONLY");
  if (company.owner.isDemo) throw fail("La demo no se paga", 403, "BILLING_DEMO");
  const sub = await ensureSubscription(company.ownerId);
  if (sub.exempt) throw fail("Esta cuenta no se paga", 409, "BILLING_EXEMPT");
  return { owner: company.owner, ownerId: company.ownerId, sub };
}

// Cliente de ONVO de la cuenta (se crea la primera vez) + llave pública para que el navegador registre la tarjeta
async function ensureCustomer(sub: { id: string; onvoCustomerId: string | null }, owner: { name: string; email: string }) {
  if (sub.onvoCustomerId) return sub.onvoCustomerId;
  const id = (await onvo.createCustomer({ name: owner.name, email: owner.email })).id;
  await prisma.subscription.update({ where: { id: sub.id }, data: { onvoCustomerId: id } });
  return id;
}

// un cobro a la vez (el que espera la verificación del banco o la transferencia SINPE vale 30 minutos)
async function assertNoPending(subscriptionId: string) {
  const pending = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId, status: "PENDING", createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
  });
  if (!pending) return;
  throw fail(
    pending.method === "SINPE"
      ? "Ya hay un pago por SINPE Móvil esperando la transferencia. Hazla o espera 30 minutos para generar otro."
      : "Ya hay un pago esperando la verificación del banco. Termínalo o espera unos minutos.",
    409,
    "BILLING_PAYMENT_PENDING",
  );
}

export async function cardSetup(companyId: string, viewerId: string) {
  const { owner, sub } = await payer(companyId, viewerId);
  return { publishableKey: onvo.onvoPublishableKey(), customerId: await ensureCustomer(sub, owner) };
}

export async function pay(companyId: string, viewerId: string, chosenMethodId?: string) {
  const { owner, ownerId, sub } = await payer(companyId, viewerId);
  if (!sub.onvoCustomerId) throw fail("Primero registra la tarjeta", 409, "BILLING_NO_CUSTOMER");
  const paymentMethodId = chosenMethodId ?? sub.paymentMethodId;
  if (!paymentMethodId) throw fail("Ingresa los datos de una tarjeta", 400, "BILLING_NO_CARD");

  // la tarjeta tiene que ser de ESTE cliente: nadie paga con una tarjeta guardada de otra cuenta
  const pm = await onvo.getPaymentMethod(paymentMethodId);
  if (pm.customerId !== sub.onvoCustomerId) throw fail("La tarjeta no pertenece a esta cuenta", 403, "BILLING_CARD_OWNER");

  await assertNoPending(sub.id);

  const plan = owner.plan;
  const interval = sub.interval;
  const amount = amountFor(plan, interval);
  const payment = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, plan, interval, amount, paymentMethodId, cardBrand: pm.card?.brand ?? null, cardLast4: pm.card?.last4 ?? null },
  });
  try {
    const intent = await onvo.createIntent({
      amount: amount * 100,
      customerId: sub.onvoCustomerId,
      description: `Cubivo plan ${plan} ${interval === "ANNUAL" ? "anual" : "mensual"}`,
      metadata: { paymentId: payment.id, userId: ownerId, plan, interval },
    });
    await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { onvoIntentId: intent.id } });
    const confirmed = await onvo.confirmIntent(intent.id, {
      paymentMethodId,
      returnUrl: `${appUrl()}/subscription?payment=${payment.id}`,
    });
    const result = await applyIntent(payment.id, confirmed);
    await logAudit(viewerId, "CREATE", "SubscriptionPayment", payment.id, { amount, plan, interval, status: result.status });
    return {
      payment: result,
      ...(confirmed.status === "requires_action" && confirmed.nextAction?.redirectToUrl?.url && { redirectUrl: confirmed.nextAction.redirectToUrl.url }),
    };
  } catch (err) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "PENDING", onvoIntentId: null },
      data: { status: "FAILED", failureMessage: (err as Error).message.slice(0, 300) },
    });
    throw err;
  }
}

// ---- SINPE Móvil (C3) ----
// Formato que exige ONVO (con guiones) según quién transfiere: persona física, residente (DIMEX) o empresa.
const SINPE_ID_TYPE = { FISICA: 0, DIMEX: 1, JURIDICA: 3 } as const;
export type SinpeIdType = keyof typeof SINPE_ID_TYPE;

export function sinpeIdentification(idType: SinpeIdType, raw: string) {
  const d = raw.replace(/\D/g, "");
  if (idType === "FISICA") {
    const n = d.length === 10 && d.startsWith("0") ? d.slice(1) : d;
    if (n.length !== 9) throw fail("La cédula física tiene 9 números (ej. 1-1393-1919)", 400, "BILLING_SINPE_ID");
    return `0${n[0]}-${n.slice(1, 5)}-${n.slice(5)}`;
  }
  if (idType === "JURIDICA") {
    if (d.length !== 10) throw fail("La cédula jurídica tiene 10 números (ej. 3-101-123456)", 400, "BILLING_SINPE_ID");
    return `${d[0]}-${d.slice(1, 4)}-${d.slice(4)}`;
  }
  if (d.length < 11 || d.length > 12) throw fail("El DIMEX tiene 11 o 12 números", 400, "BILLING_SINPE_ID");
  return d;
}

const dash4 = (n: string) => `${n.slice(0, 4)}-${n.slice(4)}`;

export const sinpeInstructions = (amount: number, identification: string) => ({
  to: dash4(onvo.sinpeDestination().replace(/^\+506/, "")),
  amount,
  identification,
});

export async function paySinpe(companyId: string, viewerId: string, input: { idType: SinpeIdType; idNumber: string; phone: string }) {
  const { owner, ownerId, sub } = await payer(companyId, viewerId);
  const identification = sinpeIdentification(input.idType, input.idNumber);
  const phone = input.phone.replace(/\D/g, "").replace(/^506(?=\d{8}$)/, "");
  if (!/^[5-8]\d{7}$/.test(phone)) throw fail("El teléfono del SINPE Móvil tiene 8 números", 400, "BILLING_SINPE_PHONE");
  await assertNoPending(sub.id);

  const customerId = await ensureCustomer(sub, owner);
  const plan = owner.plan;
  const interval = sub.interval;
  const amount = amountFor(plan, interval);
  const payment = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, method: "SINPE", plan, interval, amount, sinpeIdentification: identification },
  });
  try {
    const intent = await onvo.createIntent({
      amount: amount * 100,
      customerId,
      description: `Cubivo plan ${plan} ${interval === "ANNUAL" ? "anual" : "mensual"}`,
      metadata: { paymentId: payment.id, userId: ownerId, plan, interval },
    });
    await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { onvoIntentId: intent.id } });
    const pm = await onvo.createSinpeMethod({ customerId, identification, identificationType: SINPE_ID_TYPE[input.idType], number: `+506${phone}` });
    // queda en "processing": ONVO espera la transferencia por el monto exacto desde esa identificación
    const confirmed = await onvo.confirmIntent(intent.id, { paymentMethodId: pm.id });
    const result = await applyIntent(payment.id, confirmed);
    await logAudit(viewerId, "CREATE", "SubscriptionPayment", payment.id, { amount, plan, interval, method: "SINPE", status: result.status });
    return { payment: result };
  } catch (err) {
    await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "FAILED", failureMessage: (err as Error).message.slice(0, 300) },
    });
    throw err;
  }
}

// Al volver de la verificación del banco (o para revisar uno pendiente): se le pregunta a ONVO
export async function syncPayment(companyId: string, viewerId: string, paymentId: string) {
  const { sub } = await payer(companyId, viewerId);
  const payment = await prisma.subscriptionPayment.findFirst({ where: { id: paymentId, subscriptionId: sub.id } });
  if (!payment) throw fail("Pago no encontrado", 404, "BILLING_PAYMENT_NOT_FOUND");
  if (payment.status !== "PENDING" || !payment.onvoIntentId) return view(payment);
  return applyIntent(payment.id, await onvo.getIntent(payment.onvoIntentId));
}

const DECLINED = "El banco rechazó el pago. Revisa los datos o usa otra tarjeta.";

// Pasa el resultado de ONVO al pago. Aprobado → aplica el periodo (una sola vez, en transacción).
export async function applyIntent(paymentId: string, intent: onvo.OnvoIntent) {
  if (intent.status === "succeeded") return view(await markSucceeded(paymentId));
  const failed = intent.status === "requires_payment_method" || intent.status === "failed" || intent.status === "canceled";
  if (failed) {
    const message = intent.lastPaymentError?.message ? `${DECLINED} (${intent.lastPaymentError.message})` : DECLINED;
    await prisma.subscriptionPayment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "FAILED", failureMessage: message.slice(0, 300) } });
  }
  return view(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } }));
}

async function markSucceeded(paymentId: string) {
  return prisma.$transaction(async (tx) => {
    // solo el primero que lo ve PENDING lo aplica (vuelta del 3DS y webhook pueden llegar juntos)
    const claimed = await tx.subscriptionPayment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "SUCCEEDED", paidAt: new Date() } });
    const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { subscription: true } });
    if (claimed.count === 0) return payment;
    const sub = payment.subscription;
    const now = new Date();
    // el periodo empieza al terminar lo ya pagado o la prueba que queda (no se pierden días), o ahora si venció
    const base = [sub.paidUntil, sub.trialEndsAt].filter((d): d is Date => !!d && d > now).sort((a, b) => b.getTime() - a.getTime())[0] ?? now;
    const periodEnd = addPeriod(base, payment.interval);
    // la tarjeta con que se pagó bien queda como la de renovar (C4)
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        paidUntil: periodEnd,
        interval: payment.interval,
        ...(payment.paymentMethodId && { paymentMethodId: payment.paymentMethodId, cardBrand: payment.cardBrand, cardLast4: payment.cardLast4 }),
      },
    });
    await tx.user.update({ where: { id: sub.userId }, data: { plan: payment.plan } });
    return tx.subscriptionPayment.update({ where: { id: paymentId }, data: { periodStart: base, periodEnd } });
  });
}

type PaymentRow = Awaited<ReturnType<typeof prisma.subscriptionPayment.findUniqueOrThrow>>;
const view = (p: PaymentRow) => ({
  id: p.id,
  status: p.status,
  method: p.method,
  plan: p.plan,
  interval: p.interval,
  amount: p.amount,
  cardBrand: p.cardBrand,
  cardLast4: p.cardLast4,
  periodStart: p.periodStart,
  periodEnd: p.periodEnd,
  paidAt: p.paidAt,
  failureMessage: p.failureMessage,
  createdAt: p.createdAt,
  ...(p.method === "SINPE" && p.status === "PENDING" && p.sinpeIdentification && { sinpe: sinpeInstructions(p.amount, p.sinpeIdentification) }),
});

export async function listPayments(companyId: string, viewerId: string) {
  const { ownerId } = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { ownerId: true } });
  if (ownerId !== viewerId) throw fail("Solo el dueño de la cuenta ve los pagos", 403, "BILLING_OWNER_ONLY");
  const sub = await prisma.subscription.findUnique({ where: { userId: ownerId } });
  if (!sub) return [];
  const rows = await prisma.subscriptionPayment.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map(view);
}


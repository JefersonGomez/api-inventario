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
import { BILLING } from "../../config/plans.ts";
import { paymentReceivedEmail } from "./billing-email.ts";

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

// Orden de los planes por precio: subir = inmediato (se paga la diferencia); bajar = al próximo periodo
export const PLAN_RANK: Record<PlanCode, number> = { INVOICING: 0, BASIC: 1, PRO: 2, BUSINESS: 3 };
const MIN_CHARGE = 300; // ONVO no cobra menos de USD 0,50: una diferencia menor se regala

// Diferencia proporcional por los días que le quedan al periodo pagado (C5)
export async function upgradeQuote(sub: { id: string; paidUntil: Date | null; interval: BillingInterval }, from: PlanCode, to: PlanCode, now = new Date()) {
  if (!sub.paidUntil || sub.paidUntil <= now) return 0;
  const last = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: sub.id, status: "SUCCEEDED", kind: "PERIOD", periodEnd: sub.paidUntil },
    orderBy: { paidAt: "desc" },
  });
  // sin el pago a mano (p. ej. un periodo puesto por soporte): se asume que el periodo dura un mes o un año
  const length = addPeriod(sub.paidUntil, sub.interval).getTime() - sub.paidUntil.getTime();
  const start = last?.periodStart ?? new Date(sub.paidUntil.getTime() - length);
  const total = sub.paidUntil.getTime() - start.getTime();
  const left = Math.min(total, sub.paidUntil.getTime() - now.getTime());
  const diff = amountFor(to, sub.interval) - amountFor(from, sub.interval);
  const amount = total > 0 ? Math.ceil((diff * left) / total) : diff;
  return amount < MIN_CHARGE ? 0 : amount;
}

type Charge = { kind: "PERIOD" | "UPGRADE"; plan: PlanCode; interval: BillingInterval; amount: number };

// Qué se cobra: la diferencia si sube de plan con un periodo pagado; si no, un periodo con lo programado
async function chargeFor(
  owner: { plan: PlanCode },
  sub: { id: string; paidUntil: Date | null; interval: BillingInterval; nextPlan: PlanCode | null; nextInterval: BillingInterval | null; trialEndsAt: Date; exempt: boolean },
  upgradeTo?: PlanCode,
): Promise<Charge> {
  const active = !!sub.paidUntil && sub.paidUntil > new Date();
  if (upgradeTo) {
    if (!active) throw fail("Sin un periodo pagado el plan se cambia sin costo", 409, "BILLING_NOT_ACTIVE");
    if (PLAN_RANK[upgradeTo] <= PLAN_RANK[owner.plan]) throw fail("Ese plan no es superior al actual", 400, "BILLING_NOT_UPGRADE");
    const amount = await upgradeQuote(sub, owner.plan, upgradeTo);
    if (!amount) throw fail("La diferencia es mínima: el cambio se aplica sin cobro", 409, "BILLING_UPGRADE_FREE");
    return { kind: "UPGRADE", plan: upgradeTo, interval: sub.interval, amount };
  }
  const plan = active ? sub.nextPlan ?? owner.plan : owner.plan;
  const interval = active ? sub.nextInterval ?? sub.interval : sub.interval;
  return { kind: "PERIOD", plan, interval, amount: amountFor(plan, interval) };
}

const describe = (c: Charge) =>
  c.kind === "UPGRADE" ? `Cubivo cambio a plan ${c.plan}` : `Cubivo plan ${c.plan} ${c.interval === "ANNUAL" ? "anual" : "mensual"}`;

export async function cardSetup(companyId: string, viewerId: string) {
  const { owner, sub } = await payer(companyId, viewerId);
  return { publishableKey: onvo.onvoPublishableKey(), customerId: await ensureCustomer(sub, owner) };
}

export async function pay(companyId: string, viewerId: string, chosenMethodId?: string, upgradeTo?: PlanCode) {
  const { owner, ownerId, sub } = await payer(companyId, viewerId);
  if (!sub.onvoCustomerId) throw fail("Primero registra la tarjeta", 409, "BILLING_NO_CUSTOMER");
  const paymentMethodId = chosenMethodId ?? sub.paymentMethodId;
  if (!paymentMethodId) throw fail("Ingresa los datos de una tarjeta", 400, "BILLING_NO_CARD");

  // la tarjeta tiene que ser de ESTE cliente: nadie paga con una tarjeta guardada de otra cuenta
  const pm = await onvo.getPaymentMethod(paymentMethodId);
  if (pm.customerId !== sub.onvoCustomerId) throw fail("La tarjeta no pertenece a esta cuenta", 403, "BILLING_CARD_OWNER");

  await assertNoPending(sub.id);

  const charge = await chargeFor(owner, sub, upgradeTo);
  const { kind, plan, interval, amount } = charge;
  const payment = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, kind, plan, interval, amount, paymentMethodId, cardBrand: pm.card?.brand ?? null, cardLast4: pm.card?.last4 ?? null },
  });
  try {
    const intent = await onvo.createIntent({
      amount: amount * 100,
      customerId: sub.onvoCustomerId,
      description: describe(charge),
      metadata: { paymentId: payment.id, userId: ownerId, plan, interval, kind },
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

export async function paySinpe(companyId: string, viewerId: string, input: { idType: SinpeIdType; idNumber: string; phone: string; upgradeTo?: PlanCode }) {
  const { owner, ownerId, sub } = await payer(companyId, viewerId);
  const identification = sinpeIdentification(input.idType, input.idNumber);
  const phone = input.phone.replace(/\D/g, "").replace(/^506(?=\d{8}$)/, "");
  if (!/^[5-8]\d{7}$/.test(phone)) throw fail("El teléfono del SINPE Móvil tiene 8 números", 400, "BILLING_SINPE_PHONE");
  await assertNoPending(sub.id);

  const charge = await chargeFor(owner, sub, input.upgradeTo);
  const { kind, plan, interval, amount } = charge;
  const customerId = await ensureCustomer(sub, owner);
  const payment = await prisma.subscriptionPayment.create({
    data: { subscriptionId: sub.id, method: "SINPE", kind, plan, interval, amount, sinpeIdentification: identification },
  });
  try {
    const intent = await onvo.createIntent({
      amount: amount * 100,
      customerId,
      description: describe(charge),
      metadata: { paymentId: payment.id, userId: ownerId, plan, interval, kind },
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
  if (intent.status === "succeeded") {
    const { payment, claimed } = await markSucceeded(paymentId);
    // comprobante por correo al dueño, una sola vez (la factura electrónica llega en la C6)
    if (claimed && payment.periodEnd) {
      const owner = await prisma.user.findUniqueOrThrow({ where: { id: payment.subscription.userId }, select: { name: true, email: true } });
      await paymentReceivedEmail(owner, payment.plan, payment.amount, payment.method, payment.periodEnd).catch((e) =>
        console.error("correo de pago recibido:", (e as Error).message),
      );
    }
    return view(payment);
  }
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
    if (claimed.count === 0) return { payment, claimed: false };
    const sub = payment.subscription;
    const now = new Date();
    if (payment.kind === "UPGRADE") {
      // pagó la diferencia: el plan nuevo rige ya hasta el fin del periodo pagado (no suma tiempo)
      await tx.user.update({ where: { id: sub.userId }, data: { plan: payment.plan } });
      await tx.subscription.update({ where: { id: sub.id }, data: { nextPlan: null } });
      const updated = await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { periodStart: now, periodEnd: sub.paidUntil }, include: { subscription: true } });
      return { payment: updated, claimed: true };
    }
    // el periodo empieza al terminar lo ya pagado o la prueba que queda (no se pierden días); si venció hace poco
    // (dentro de la gracia) sigue desde el vencimiento, para que la renovación sea continua; si no, desde ahora
    const future = [sub.paidUntil, sub.trialEndsAt].filter((d): d is Date => !!d && d > now).sort((a, b) => b.getTime() - a.getTime())[0];
    const inGrace = sub.paidUntil && sub.paidUntil <= now && sub.paidUntil.getTime() > now.getTime() - BILLING.graceDays * 86_400_000 ? sub.paidUntil : null;
    const base = future ?? inGrace ?? now;
    const periodEnd = addPeriod(base, payment.interval);
    // la tarjeta con que se pagó bien queda como la de renovar (C4)
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        paidUntil: periodEnd,
        interval: payment.interval,
        nextPlan: null,
        nextInterval: null,
        cancelAtPeriodEnd: false, // pagar otro periodo deshace la cancelación
        ...(payment.paymentMethodId && { paymentMethodId: payment.paymentMethodId, cardBrand: payment.cardBrand, cardLast4: payment.cardLast4 }),
      },
    });
    await tx.user.update({ where: { id: sub.userId }, data: { plan: payment.plan } });
    const updated = await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { periodStart: base, periodEnd }, include: { subscription: true } });
    return { payment: updated, claimed: true };
  });
}

type PaymentRow = Awaited<ReturnType<typeof prisma.subscriptionPayment.findUniqueOrThrow>>;
const view = (p: PaymentRow) => ({
  automatic: p.automatic,
  kind: p.kind,
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


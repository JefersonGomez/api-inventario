// Correos de la suscripción (C4): los manda Cubivo al dueño de la cuenta, desde EMAIL_FROM.
// Cada uno lleva el botón a Mi suscripción (o al enlace del banco cuando hay que confirmar un cobro).
import { escapeHtml, sendEmail } from "../../shared/email.ts";

const appUrl = () => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const money = (n: number) => `₡${new Intl.NumberFormat("es-CR").format(n)}`;
const day = (d: Date) => d.toLocaleDateString("es-CR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Costa_Rica" });
const PLAN = { INVOICING: "Solo facturación", BASIC: "Básico", PRO: "Pro", BUSINESS: "Empresarial" } as const;
export type PlanName = keyof typeof PLAN;

function layout(title: string, paragraphs: string[], button?: { text: string; url: string }) {
  return `<div style="font-family:Arial,sans-serif;color:#1f2933;max-width:560px;line-height:1.5">
  <p style="margin:0 0 16px;font-weight:bold;color:#2f6fa8">Cubivo</p>
  <h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(title)}</h2>
  ${paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join("\n  ")}
  ${button ? `<p style="margin:20px 0"><a href="${escapeHtml(button.url)}" style="background:#2f6fa8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(button.text)}</a></p>` : ""}
  <p style="margin:24px 0 0;font-size:12px;color:#6b7785">¿Dudas? Responde este correo o escríbenos a hola@cubivo.org.</p>
</div>`;
}

type To = { email: string; name: string };
const hi = (to: To) => `Hola ${escapeHtml(to.name.split(/\s+/)[0] ?? to.name)},`;
const subscriptionUrl = () => `${appUrl()}/subscription`;
const send = (to: To, subject: string, html: string) => sendEmail({ to: to.email, subject, html, replyTo: "hola@cubivo.org" });

export function trialEndingEmail(to: To, plan: PlanName, endsAt: Date) {
  return send(to, `Tu prueba de Cubivo termina el ${day(endsAt)}`, layout("Tu prueba gratis está por terminar", [
    hi(to),
    `Tu prueba gratis del plan <b>${PLAN[plan]}</b> termina el <b>${day(endsAt)}</b>. Para seguir vendiendo y facturando sin interrupciones, elige cómo pagar: con tarjeta o por SINPE Móvil.`,
    "Si no pagas, tienes 3 días de gracia; después la cuenta queda en solo lectura (puedes ver y exportar todo, nunca se borra nada).",
  ], { text: "Elegir cómo pagar", url: subscriptionUrl() }));
}

export function renewalReminderEmail(to: To, plan: PlanName, amount: number, endsAt: Date) {
  return send(to, `Tu plan de Cubivo vence el ${day(endsAt)}`, layout("Tu plan está por vencer", [
    hi(to),
    `Tu plan <b>${PLAN[plan]}</b> está pagado hasta el <b>${day(endsAt)}</b>. Para renovarlo, paga <b>${money(amount)}</b> con SINPE Móvil o con tarjeta desde Mi suscripción.`,
    "Si registras una tarjeta, la renovación se cobra sola cada periodo.",
  ], { text: "Renovar ahora", url: subscriptionUrl() }));
}

export function paymentReceivedEmail(to: To, plan: PlanName, amount: number, method: string, periodEnd: Date) {
  return send(to, `Pago recibido: ${money(amount)} · Cubivo`, layout("¡Gracias! Recibimos tu pago", [
    hi(to),
    `Recibimos <b>${money(amount)}</b> ${method === "SINPE" ? "por SINPE Móvil" : "con tarjeta"} por el plan <b>${PLAN[plan]}</b>.`,
    `Tu plan está al día hasta el <b>${day(periodEnd)}</b>.`,
  ], { text: "Ver mi suscripción", url: subscriptionUrl() }));
}

export function confirmChargeEmail(to: To, amount: number, url: string) {
  return send(to, "Confirma el cobro de tu plan de Cubivo", layout("Tu banco pide confirmar el cobro", [
    hi(to),
    `Intentamos cobrar <b>${money(amount)}</b> por la renovación de tu plan, pero tu banco pide que confirmes el pago. No tienes que volver a escribir la tarjeta.`,
  ], { text: "Confirmar con mi banco", url }));
}

export function chargeFailedEmail(to: To, amount: number, card: string | null, retry: boolean) {
  return send(to, "No pudimos cobrar tu plan de Cubivo", layout("No pudimos cobrar la renovación", [
    hi(to),
    `El cobro de <b>${money(amount)}</b>${card ? ` a tu tarjeta ${escapeHtml(card)}` : ""} fue rechazado.`,
    retry
      ? "Lo intentaremos de nuevo mañana. También puedes pagar ahora con otra tarjeta o por SINPE Móvil."
      : "Ya no lo vamos a reintentar: paga con otra tarjeta o por SINPE Móvil para que tu cuenta siga al día.",
  ], { text: "Pagar ahora", url: subscriptionUrl() }));
}

export function expiredEmail(to: To) {
  return send(to, "Tu cuenta de Cubivo está en solo lectura", layout("Tu cuenta quedó en solo lectura", [
    hi(to),
    "Terminaron los días de gracia sin un pago. Tu cuenta y tus datos siguen ahí: puedes verlos y exportarlos, pero no vender ni facturar.",
    "Apenas pagues, todo vuelve a funcionar al instante.",
  ], { text: "Pagar y reactivar", url: subscriptionUrl() }));
}

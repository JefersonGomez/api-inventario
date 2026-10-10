// Envío de correo vía la API REST de Resend (sin SDK: es un solo POST).
// Sin dominio verificado (EMAIL_FROM vacío) Resend solo deja enviar desde onboarding@resend.dev
// y solo al correo de la cuenta: en ese modo todo va a EMAIL_TEST_TO y el asunto indica el destinatario real.
export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Falta RESEND_API_KEY en el servidor");

  const from = process.env.EMAIL_FROM;
  const testTo = process.env.EMAIL_TEST_TO;
  if (!from && !testTo) throw new Error("Configura EMAIL_FROM (dominio verificado) o EMAIL_TEST_TO (modo prueba)");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(
      from
        ? { from, to, subject, html }
        : { from: "onboarding@resend.dev", to: testTo, subject: `[Prueba → ${to}] ${subject}`, html }
    ),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`No se pudo enviar el correo (${res.status}): ${detail}`);
  }
  return { testMode: !from };
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

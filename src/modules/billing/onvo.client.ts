// Cliente mínimo de la API de ONVO Pay (REST, sin SDK). Probado en modo prueba el 25-nov-2026:
// - el navegador registra la tarjeta con la llave PÚBLICA (POST /v1/payment-methods + customerId): los datos
//   de la tarjeta nunca pasan por este servidor;
// - el servidor crea la intención y la confirma con ese paymentMethodId; el mismo id sirve para cobrar
//   otra vez el mes siguiente (C4);
// - si el banco pide 3DS: status requires_action + nextAction.redirectToUrl.url; al volver se consulta el GET.
// NO se usa el objeto subscription de ONVO: deja el 3DS en incomplete (guía del usuario, confirmado por soporte).
// Montos en céntimos (₡14 900 = 1490000).

const API = "https://api.onvopay.com/v1";

type HttpError = Error & { status?: number; code?: string };
const fail = (message: string, status: number, code: string): HttpError => Object.assign(new Error(message), { status, code });

export const onvoConfigured = () => !!process.env.ONVO_SECRET_KEY && !!process.env.ONVO_PUBLISHABLE_KEY;
export const onvoPublishableKey = () => process.env.ONVO_PUBLISHABLE_KEY ?? "";

async function onvo<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = process.env.ONVO_SECRET_KEY;
  if (!key) throw fail("El cobro con tarjeta no está configurado en el servidor", 503, "ONVO_NOT_CONFIGURED");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* respuesta sin JSON */
  }
  if (!res.ok) {
    const msg = (json as { message?: string | string[] } | null)?.message;
    throw fail(`ONVO respondió ${res.status}: ${Array.isArray(msg) ? msg.join(", ") : msg ?? "error"}`, 502, "ONVO_ERROR");
  }
  return json as T;
}

export type OnvoIntent = {
  id: string;
  status: "requires_payment_method" | "requires_action" | "requires_capture" | "processing" | "succeeded" | "failed" | "canceled" | string;
  amount: number;
  customerId?: string | null;
  nextAction?: { type?: string; redirectToUrl?: { url?: string } } | null;
  lastPaymentError?: { code?: string; message?: string } | null;
  paymentMethod?: { id: string; card?: { brand?: string; last4?: string } | null } | null;
  metadata?: Record<string, string> | null;
};

export type OnvoPaymentMethod = { id: string; customerId?: string | null; status?: string; card?: { brand?: string; last4?: string } | null };

export const createCustomer = (data: { name: string; email: string }) => onvo<{ id: string }>("POST", "/customers", data);

export const getPaymentMethod = (id: string) => onvo<OnvoPaymentMethod>("GET", `/payment-methods/${encodeURIComponent(id)}`);

// SINPE Móvil (C3): el método lleva la identificación de QUIEN transfiere (con guiones) y su teléfono; ONVO
// acepta la transferencia que coincida en identificación y monto exacto con una intención en "processing".
export const createSinpeMethod = (data: { customerId: string; identification: string; identificationType: number; number: string }) =>
  onvo<OnvoPaymentMethod>("POST", "/payment-methods", {
    type: "mobile_number",
    customerId: data.customerId,
    mobileNumber: { identification: data.identification, identificationType: data.identificationType, number: data.number },
  });

// Número al que se transfiere (por defecto el de ONVO; su soporte puede asignar uno propio)
export const sinpeDestination = () => process.env.ONVO_SINPE_NUMBER || "+50670196686";

export const createIntent = (data: { amount: number; customerId: string; description: string; metadata: Record<string, string> }) =>
  onvo<OnvoIntent>("POST", "/payment-intents", { ...data, currency: "CRC" });

export const confirmIntent = (id: string, data: { paymentMethodId: string; returnUrl?: string }) =>
  onvo<OnvoIntent>("POST", `/payment-intents/${encodeURIComponent(id)}/confirm`, data);

// Cancelar una intención que nadie terminó (SINPE que no llegó, 3DS abandonado): ya no acepta el pago (probado 25-nov)
export const cancelIntent = (id: string) => onvo<OnvoIntent>("POST", `/payment-intents/${encodeURIComponent(id)}/cancel`);

export const getIntent = (id: string) => onvo<OnvoIntent>("GET", `/payment-intents/${encodeURIComponent(id)}`);

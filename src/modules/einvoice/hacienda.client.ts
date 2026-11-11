// Comunicación con Hacienda (API de recepción v1): token OAuth2 del IDP, envío y consulta de estado.
// Ningún otro módulo habla con Hacienda. Los errores nunca incluyen la clave del usuario.
import { HACIENDA_ENDPOINTS, type HaciendaEnv } from "./codes.ts"

export type HaciendaCredentials = { env: HaciendaEnv; username: string; password: string }

// Token por ambiente y usuario, reutilizado hasta 30 s antes de vencer (dura 5 minutos)
const tokens = new Map<string, { value: string; expires: number }>()

async function token(c: HaciendaCredentials, fresh = false) {
  const key = `${c.env}:${c.username}`
  const cached = tokens.get(key)
  if (!fresh && cached && cached.expires > Date.now()) return cached.value
  const ep = HACIENDA_ENDPOINTS[c.env]
  const res = await fetch(ep.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: ep.clientId, username: c.username, password: c.password }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`Hacienda no dio acceso (${res.status}${body.error_description ? `: ${body.error_description}` : ""}); revisa el usuario y la clave`)
  }
  tokens.set(key, { value: body.access_token, expires: Date.now() + ((body.expires_in ?? 300) - 30) * 1000 })
  return body.access_token
}

// Prueba usuario y clave pidiendo un token nuevo (al guardar la configuración o con "Probar conexión")
export async function checkCredentials(c: HaciendaCredentials) {
  await token(c, true)
}

export type SendPayload = {
  clave: string
  fecha: string // FechaEmision del comprobante
  emisor: { tipoIdentificacion: string; numeroIdentificacion: string }
  receptor?: { tipoIdentificacion: string; numeroIdentificacion: string }
  comprobanteXml: string // XML firmado en base64
}

// Envía el comprobante. 201/202 = recibido. Si ya se había recibido, Hacienda responde 400 con
// X-Error-Cause "...ya fue recibido..."; se trata como recibido para poder reintentar sin miedo.
export async function sendToHacienda(c: HaciendaCredentials, payload: SendPayload) {
  const res = await fetch(`${HACIENDA_ENDPOINTS[c.env].api}/recepcion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(c)}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  const cause = res.headers.get("x-error-cause") ?? ""
  if (res.ok) return { received: true as const, status: res.status }
  if (res.status === 400 && /ya fue recibid|ya existe/i.test(cause)) return { received: true as const, status: res.status }
  return { received: false as const, status: res.status, error: cause || `Hacienda respondió ${res.status}` }
}

export type HaciendaStatus = {
  state: "aceptado" | "rechazado" | "procesando" | "recibido" | "error" | string
  responseXml: string | null // MensajeHacienda decodificado
  message: string | null // DetalleMensaje
}

// Consulta el estado de un comprobante por su clave (404 = Hacienda todavía no lo tiene)
export async function haciendaStatus(c: HaciendaCredentials, clave: string): Promise<HaciendaStatus | null> {
  const res = await fetch(`${HACIENDA_ENDPOINTS[c.env].api}/recepcion/${clave}`, {
    headers: { Authorization: `Bearer ${await token(c)}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Hacienda respondió ${res.status} al consultar el estado${res.headers.get("x-error-cause") ? `: ${res.headers.get("x-error-cause")}` : ""}`)
  const body = (await res.json()) as { "ind-estado"?: string; "respuesta-xml"?: string }
  const responseXml = body["respuesta-xml"] ? Buffer.from(body["respuesta-xml"], "base64").toString("utf8") : null
  const detail = responseXml?.match(/<DetalleMensaje>([\s\S]*?)<\/DetalleMensaje>/)?.[1] ?? null
  return { state: (body["ind-estado"] ?? "procesando").toLowerCase(), responseXml, message: cleanHaciendaMessage(detail) }
}

// DetalleMensaje viene con un aviso fijo del ambiente de pruebas y los errores en un "CSV"
// (codigo, mensaje, fila, columna). Se deja solo lo útil: "mensaje (código -400)", uno por línea.
export function cleanHaciendaMessage(detail: string | null | undefined): string | null {
  if (!detail) return null
  const text = detail.replace(/&#13;/g, "").replace(/\r/g, "")
    .replace(/Este comprobante fue recibido en el ambiente de pruebas[^\n]*\n?/i, "")
  const items = [...text.matchAll(/^\s*(-?\d+)\s*,\s*"((?:[^"]|"")*)"\s*,\s*\d+\s*,\s*\d+\s*$/gm)]
    .map((m) => `${m[2]!.replace(/""/g, "\"").trim()} (código ${m[1]})`)
  if (items.length) return items.join("\n")
  return text.replace(/""/g, "\"").trim() || null
}

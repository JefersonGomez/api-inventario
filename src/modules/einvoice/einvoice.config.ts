// Credenciales de Hacienda. Fase 1: una sola empresa, desde el .env (HACIENDA_*). Más adelante cada
// empresa sube su llave y queda cifrada en la base (punto 46); este archivo es el único que cambia.
// La llave se lee una vez y queda en memoria; nunca se registra ni se devuelve.
import { readFileSync, statSync } from "node:fs"
import type { HaciendaEnv } from "./codes.ts"
import type { HaciendaCredentials } from "./hacienda.client.ts"
import { loadSigningKey, type SigningKey } from "./signer.ts"

export type EInvoiceConfig = { credentials: HaciendaCredentials; key: SigningKey; provider: string }

let cached: { stamp: string; config: EInvoiceConfig } | null = null

export async function einvoiceConfig(): Promise<EInvoiceConfig> {
  const e = process.env
  const env = e.HACIENDA_ENV as HaciendaEnv | undefined
  if (!env || !e.HACIENDA_USER || !e.HACIENDA_PASSWORD || !e.HACIENDA_P12_PATH || !e.HACIENDA_P12_PIN) {
    throw Object.assign(new Error("La facturación electrónica no está configurada (faltan las credenciales de Hacienda)"), { status: 409, code: "EINVOICE_NOT_CONFIGURED" })
  }
  if (env !== "pruebas" && env !== "produccion") throw new Error('HACIENDA_ENV debe ser "pruebas" o "produccion"')
  let mtime: number
  try {
    mtime = statSync(e.HACIENDA_P12_PATH).mtimeMs
  } catch {
    throw Object.assign(new Error("No se encontró la llave criptográfica en la ruta configurada"), { status: 409, code: "EINVOICE_NOT_CONFIGURED" })
  }
  const stamp = `${env}|${e.HACIENDA_USER}|${e.HACIENDA_P12_PATH}|${mtime}`
  if (cached?.stamp === stamp) return cached.config
  const key = await loadSigningKey(readFileSync(e.HACIENDA_P12_PATH), e.HACIENDA_P12_PIN)
  const config = {
    credentials: { env, username: e.HACIENDA_USER, password: e.HACIENDA_PASSWORD },
    key,
    provider: (e.HACIENDA_PROVEEDOR || key.holderId).replace(/\D/g, ""), // cédula de quien provee el sistema
  }
  cached = { stamp, config }
  return config
}

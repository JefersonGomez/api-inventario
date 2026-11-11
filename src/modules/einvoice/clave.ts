// Clave numérica de 50 dígitos (Anexos v4.4): país (506) + fecha ddmmaa + identificación del emisor en
// 12 dígitos + consecutivo de 20 + situación (1 normal, 2 contingencia, 3 sin internet) + código de
// seguridad de 8 dígitos. La fecha es la de Costa Rica (UTC−6, sin horario de verano).
import { randomInt } from "node:crypto"

const CR_OFFSET_MS = -6 * 3_600_000
export type Situation = "1" | "2" | "3"

// Fecha y hora de Costa Rica como texto ISO con su desfase: 2026-11-10T19:30:05-06:00
export function crDateTime(d: Date) {
  return `${new Date(d.getTime() + CR_OFFSET_MS).toISOString().slice(0, 19)}-06:00`
}

export const securityCode = () => String(randomInt(0, 100_000_000)).padStart(8, "0")

export function buildClave(p: { issuedAt: Date; idNumber: string; consecutive: string; situation?: Situation; code?: string }) {
  const local = crDateTime(p.issuedAt) // AAAA-MM-DDThh...
  const ddmmyy = `${local.slice(8, 10)}${local.slice(5, 7)}${local.slice(2, 4)}`
  const id = p.idNumber.replace(/\D/g, "")
  if (!id || id.length > 12) throw new Error("La identificación del emisor no es válida para la clave")
  if (!/^\d{20}$/.test(p.consecutive)) throw new Error("El consecutivo debe tener 20 dígitos")
  const code = p.code ?? securityCode()
  if (!/^\d{8}$/.test(code)) throw new Error("El código de seguridad debe tener 8 dígitos")
  return `506${ddmmyy}${id.padStart(12, "0")}${p.consecutive}${p.situation ?? "1"}${code}`
}

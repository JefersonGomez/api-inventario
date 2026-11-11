// Consulta pública de contribuyentes de Hacienda (sin credenciales): con la cédula trae el nombre
// exacto y el tipo de identificación, para registrar al cliente de una factura sin errores de tipeo.
import type { IdType } from "../../generated/prisma/enums.ts"

type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })

const ID_TYPE: Record<string, IdType> = { "01": "FISICA", "02": "JURIDICA", "03": "DIMEX", "04": "NITE" }

type Answer = {
  nombre?: string
  tipoIdentificacion?: string
  situacion?: { estado?: string }
  actividades?: { estado?: string; codigo?: string; descripcion?: string }[]
}

export async function lookupTaxpayer(raw: string) {
  const id = raw.replace(/\D/g, "")
  if (!/^\d{9,12}$/.test(id)) throw fail("Escribe la cédula completa, sin guiones (9 a 12 dígitos)", 400, "TAXPAYER_ID")
  let res: Response
  try {
    res = await fetch(`https://api.hacienda.go.cr/fe/ae?identificacion=${id}`, { signal: AbortSignal.timeout(10_000) })
  } catch {
    throw fail("Hacienda no responde en este momento: escribe el nombre a mano", 502, "TAXPAYER_UNAVAILABLE")
  }
  if (res.status === 404) throw fail("Hacienda no tiene registrada esa identificación: revisa el número", 404, "TAXPAYER_NOT_FOUND")
  if (!res.ok) throw fail("Hacienda no responde en este momento: escribe el nombre a mano", 502, "TAXPAYER_UNAVAILABLE")
  const a = (await res.json()) as Answer
  if (!a.nombre) throw fail("Hacienda no tiene registrada esa identificación: revisa el número", 404, "TAXPAYER_NOT_FOUND")
  return {
    idNumber: id,
    name: a.nombre.trim().replace(/\s+/g, " "),
    idType: ID_TYPE[a.tipoIdentificacion ?? ""] ?? null,
    status: a.situacion?.estado ?? null, // "Inscrito", "No inscrito"...
    activities: (a.actividades ?? []).filter((x) => x.estado === "A" && x.codigo).map((x) => ({ code: x.codigo!, description: x.descripcion ?? "" })),
  }
}

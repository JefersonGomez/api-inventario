// Catálogo CABYS de Hacienda (consulta pública, sin credenciales): buscar el código de un producto por
// texto o revisar que un código exista, con la tarifa de IVA que Hacienda le asigna.
import type { TaxRate } from "../../generated/prisma/enums.ts"

type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })

const RATE: Record<number, TaxRate> = { 0: "EXEMPT", 1: "RATE_1", 2: "RATE_2", 4: "RATE_4", 13: "RATE_13" }
type Item = { codigo?: string; descripcion?: string; impuesto?: number }
const view = (x: Item) => ({
  code: x.codigo!,
  description: (x.descripcion ?? "").trim(),
  taxPercent: x.impuesto ?? null,
  taxRate: x.impuesto == null ? null : (RATE[x.impuesto] ?? null), // la tarifa del sistema que corresponde
})
export type CabysItem = ReturnType<typeof view>

async function ask(params: string) {
  try {
    const res = await fetch(`https://api.hacienda.go.cr/fe/cabys?${params}`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as Item[] | { cabys?: Item[]; total?: number }
  } catch {
    throw fail("Hacienda no responde en este momento: intenta de nuevo en un rato", 502, "CABYS_UNAVAILABLE")
  }
}

// q: texto ("martillo") o un código de 13 dígitos
export async function searchCabys(raw: string) {
  const q = raw.trim()
  if (/^\d{13}$/.test(q)) {
    const found = await ask(`codigo=${q}`)
    const items = (Array.isArray(found) ? found : (found.cabys ?? [])).filter((x) => x.codigo)
    return { items: items.map(view), total: items.length }
  }
  if (q.length < 3) throw fail("Escribe al menos 3 letras para buscar", 400, "CABYS_QUERY")
  const found = await ask(`q=${encodeURIComponent(q.slice(0, 80))}&top=20`)
  const list = Array.isArray(found) ? found : (found.cabys ?? [])
  return { items: list.filter((x) => x.codigo).map(view), total: Array.isArray(found) ? list.length : (found.total ?? list.length) }
}

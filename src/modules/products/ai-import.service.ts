// Ayuda de la IA para importar productos (Bloque 6C, decisiones del usuario del 16-oct-2026).
// NO se manda el archivo: solo las primeras filas (máx. 25, celdas recortadas). La IA dice en qué fila
// están los encabezados y qué columna es cada dato; el importador de siempre hace el resto con todas
// las filas. Cuesta lo mismo con 50 o 5.000 filas. Se guarda la respuesta por "firma" de las primeras
// filas: el mismo formato otra vez (la lista mensual del mismo proveedor) no vuelve a consultar.
// Tope por plan y por mes (Básico 5, Pro 30, Empresa 100); las respuestas guardadas no cuentan.
import { createHash } from "node:crypto"
import { z } from "zod"
import { Type } from "@google/genai"
import { prismaRoot } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { getCompany } from "../company/company.service.ts"
import { generateMetered, MODELS } from "../ai/ai.service.ts"

// datos que entiende el importador (mismos campos que el frontend, lib/product-import.js)
export const IMPORT_FIELDS = [
  "sku", "name", "category", "price", "cost", "stock", "minStock", "unit", "taxRate", "cabys", "barcode", "description", "supplier", "expirationDate",
] as const

const MAX_ROWS = 25
const MAX_CELL = 80
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const aiMapSchema = z.object({ rows: z.array(z.array(cell).max(60)).min(1).max(MAX_ROWS) })

export class AiQuotaError extends Error {}

type AiMapping = { headerRow: number; mapping: Partial<Record<(typeof IMPORT_FIELDS)[number], number>> }

// Pregunta a Gemini (reemplazable en los tests)
let ask = async (prompt: string, userId: string): Promise<string> => {
  const res = await generateMetered("IMPORT", {
    model: MODELS.light,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          headerRow: { type: Type.INTEGER, description: "Índice (desde 0) de la fila con los encabezados" },
          columns: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { field: { type: Type.STRING, enum: [...IMPORT_FIELDS] }, column: { type: Type.INTEGER } },
              required: ["field", "column"],
            },
          },
        },
        required: ["headerRow", "columns"],
      },
    },
  }, userId)
  return res.text ?? ""
}
export const setImportAskerForTests = (fn: typeof ask) => { ask = fn }

const PROMPT = `Eres un asistente que ayuda a importar un catálogo de productos desde una hoja de cálculo.
Te doy las primeras filas tal cual vienen (pueden tener títulos, filas vacías o encabezados con otros nombres).
Indica:
- headerRow: el índice (desde 0) de la fila que tiene los encabezados de las columnas.
- columns: para cada dato que identifiques, el índice (desde 0) de la columna que lo contiene. Datos posibles:
  sku (código interno), name (nombre del producto, el más importante), category, price (precio de venta, con IVA),
  cost (costo / precio de compra), stock (existencias), minStock (mínimo), unit (unidad de medida), taxRate (IVA),
  cabys (código de 13 dígitos), barcode (código de barras EAN/UPC), description, supplier (proveedor),
  expirationDate (vencimiento).
No inventes columnas: si un dato no está, no lo incluyas. Cada columna como mucho una vez.
Filas (JSON, una por línea):
`

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }

export async function aiImportQuota() {
  const { limits } = await getCompany()
  const used = await prismaRoot.aiUsage.count({ where: { companyId: currentCompanyId(), feature: "IMPORT", createdAt: { gte: monthStart() } } })
  return { used, limit: limits.aiImportsPerMonth, remaining: Math.max(0, limits.aiImportsPerMonth - used) }
}

export async function aiMapColumns(input: z.infer<typeof aiMapSchema>, userId: string) {
  // muestra recortada: nunca más de 25 filas ni celdas largas
  const rows = input.rows.slice(0, MAX_ROWS).map((r) => r.map((c) => (c === null ? "" : String(c).slice(0, MAX_CELL))))
  const width = Math.max(...rows.map((r) => r.length))
  const signature = createHash("sha256").update(JSON.stringify(rows.slice(0, 5))).digest("hex").slice(0, 32)
  const cacheKey = `aiImport:${currentCompanyId()}:${signature}`

  const cached = await prismaRoot.platformSetting.findUnique({ where: { key: cacheKey } })
  if (cached) return { ...(cached.value as AiMapping), cached: true, ...(await aiImportQuota()) }

  const quota = await aiImportQuota()
  if (quota.remaining <= 0) {
    throw new AiQuotaError(`Tu plan incluye ${quota.limit} importaciones con IA al mes y ya las usaste. Puedes indicar las columnas a mano.`)
  }

  const raw = await ask(PROMPT + rows.map((r) => JSON.stringify(r)).join("\n"), userId)
  let parsed: { headerRow?: unknown; columns?: { field?: unknown; column?: unknown }[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("La IA no devolvió una respuesta válida: intenta de nuevo o indica las columnas a mano")
  }
  // se valida todo lo que dice la IA: fila y columnas dentro de la muestra, campos conocidos, sin repetir
  const headerRow = Number.isInteger(parsed.headerRow) && (parsed.headerRow as number) >= 0 && (parsed.headerRow as number) < rows.length
    ? (parsed.headerRow as number) : 0
  const mapping: AiMapping["mapping"] = {}
  const usedColumns = new Set<number>()
  for (const c of parsed.columns ?? []) {
    const field = IMPORT_FIELDS.find((f) => f === c.field)
    const column = c.column
    if (!field || !Number.isInteger(column) || (column as number) < 0 || (column as number) >= width) continue
    if (mapping[field] !== undefined || usedColumns.has(column as number)) continue
    mapping[field] = column as number
    usedColumns.add(column as number)
  }
  const result: AiMapping = { headerRow, mapping }
  await prismaRoot.platformSetting.upsert({ where: { key: cacheKey }, create: { key: cacheKey, value: result }, update: { value: result } })
  return { ...result, cached: false, ...(await aiImportQuota()) }
}

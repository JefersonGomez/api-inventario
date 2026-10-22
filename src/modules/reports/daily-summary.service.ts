// Resumen del día con IA (Bloque 6D, decisiones del 16-oct-2026): los números los calcula el servidor y
// la IA solo los redacta en pocas líneas. Uno por día por empresa, guardado: abrirlo diez veces cuesta una.
// Es de toda la empresa y sin costos (lo ve cualquiera con reports.view). Si la IA está en pausa o falla,
// se devuelven igual los números (text: null). Desde 7D-2 incluye las ventas del día (sales-report.service).
import { z } from "zod"
import { prisma, prismaRoot } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { pageArgs, pageQuery, pageResult, queryFlag } from "../../shared/pagination.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { generateMetered, MODELS } from "../ai/ai.service.ts"
import { salesOfDay } from "./sales-report.service.ts"

export const dailySummaryQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // día del navegador (la clave del resumen guardado)
  since: z.coerce.date(), // inicio de ese día en la zona del navegador
})
export type DailySummaryQuery = z.infer<typeof dailySummaryQuerySchema>

type SummaryData = Awaited<ReturnType<typeof computeDay>>

async function computeDay(since: Date) {
  const soon = new Date(since.getTime() + 8 * 24 * 60 * 60 * 1000)
  const [moves, lowStock, expiringLots, expiringProducts, pendingRequests, openOrders, inTransit, openCounts, sales] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ["type", "source"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prismaRoot.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "Product" WHERE "companyId" = ${currentCompanyId()} AND "deletedAt" IS NULL AND "stock" <= "minStock"`,
    prisma.productLot.count({ where: { quantity: { gt: 0 }, expiresAt: { not: null, lte: soon }, product: { deletedAt: null } } }),
    prisma.product.count({ where: { deletedAt: null, tracksLots: false, expirationDate: { not: null, lte: soon } } }),
    prisma.purchaseRequest.count({ where: { status: "PENDING" } }),
    prisma.purchaseOrder.count({ where: { status: { in: ["PENDING", "PARTIAL"] } } }),
    prisma.stockTransfer.count({ where: { status: "IN_TRANSIT" } }),
    prisma.stockCount.count({ where: { status: "OPEN" } }),
    salesOfDay(since),
  ])
  const count = (type: string, sources?: string[]) =>
    moves.filter((m) => m.type === type && (!sources || sources.includes(m.source))).reduce((s, m) => s + m._count._all, 0)
  return {
    movements: {
      in: count("IN"), out: count("OUT"), adjustments: count("ADJUSTMENT"),
      received: count("IN", ["PURCHASE_RECEIPT"]), transfers: count("OUT", ["TRANSFER"]) + count("IN", ["TRANSFER"]), counts: count("IN", ["COUNT"]) + count("OUT", ["COUNT"]),
    },
    lowStock: Number(lowStock[0]?.n ?? 0),
    expiringSoon: expiringLots + expiringProducts,
    pendingRequests,
    openOrders,
    transfersInTransit: inTransit,
    openCounts,
    // ventas del día (montos con IVA): neto, devoluciones, tiquetes, más vendidos, abonos, cuotas vencidas, arqueos con diferencia
    sales,
  }
}

const PROMPT = `Eres el asistente de un sistema de inventario y punto de venta. Con estos números del día escribe un resumen breve en español
para el dueño del negocio: 3 a 5 viñetas cortas ("- "), lo más importante primero, y una última línea con la acción
más urgente si la hay. Usa solo estos números; no inventes nada; si todo está en cero, dilo en una línea.
Los montos de "sales" van con IVA y en la moneda de la empresa (sin símbolo); si sales.tickets es 0, no hables de ventas.
Números del día (JSON):
`

// Redacta con Gemini (reemplazable en los tests)
let write = async (prompt: string, userId: string) =>
  (await generateMetered("DAILY_SUMMARY", { model: MODELS.light, contents: prompt }, userId)).text?.trim() || null
export const setSummaryWriterForTests = (fn: typeof write) => { write = fn }

const toView = (r: { id: string; date: string; data: unknown; text: string; createdAt: Date }) =>
  ({ id: r.id, date: r.date, data: r.data as SummaryData, text: r.text, generatedAt: r.createdAt.toISOString() })

// El último resumen guardado de ese día (o null): no genera nada ni gasta
export async function peekDailySummary(q: DailySummaryQuery) {
  const row = await prisma.dailySummary.findFirst({ where: { date: q.date }, orderBy: { createdAt: "desc" } })
  return row ? toView(row) : null
}

// Genera el resumen del día (si ya hay uno, lo devuelve; con force genera otro y quedan los dos en el
// historial). Si la IA falla, devuelve los números sin texto y no guarda.
export async function getDailySummary(q: DailySummaryQuery, userId: string, force = false) {
  if (!force) {
    const existing = await peekDailySummary(q)
    if (existing) return existing
  }
  const data = await computeDay(q.since)
  let text: string | null = null
  try {
    text = await write(PROMPT + JSON.stringify(data), userId)
  } catch {
    // IA en pausa, sin clave o caída: se muestran los números sin texto (y se reintenta la próxima vez)
  }
  if (!text) return { id: null, date: q.date, data, text: null, generatedAt: new Date().toISOString() }
  const row = await prisma.dailySummary.create({
    data: { companyId: currentCompanyId(), date: q.date, text, data: data as unknown as Prisma.InputJsonValue, createdById: userId },
  })
  return toView(row)
}

export const summaryHistorySchema = z.object({
  ...pageQuery,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  all: queryFlag, // sin paginar (para descargar el historial)
})
export type SummaryHistoryQuery = z.infer<typeof summaryHistorySchema>

// Historial: todos los resúmenes guardados, el más nuevo primero
export async function summaryHistory(f: SummaryHistoryQuery) {
  const where = { ...((f.from || f.to) && { date: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } }) }
  const order = [{ date: "desc" as const }, { createdAt: "desc" as const }]
  if (f.all) {
    return (await prisma.dailySummary.findMany({ where, orderBy: order, take: 5000 })).map(toView)
  }
  const [total, items] = await Promise.all([
    prisma.dailySummary.count({ where }),
    prisma.dailySummary.findMany({ where, orderBy: order, ...pageArgs(f) }),
  ])
  return pageResult(items.map(toView), total, f)
}

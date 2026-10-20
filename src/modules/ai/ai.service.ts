// Toda llamada a Gemini pasa por aquí (Bloque 6A): revisa el presupuesto del mes, llama, anota tokens y
// costo estimado (medidor) y avisa al dueño de la plataforma si el gasto llega al umbral de alerta.
// Al pasar el presupuesto, la IA queda en pausa hasta el mes siguiente (decisión del usuario, 16-oct-2026).
import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai"
import { prismaRoot } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import type { AiFeature } from "../../generated/prisma/enums.ts"
import { currentCompanyIdOrNull } from "../../shared/tenant.ts"

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "API_KEY_DEFAULT" })

// Modelos: el asistente (con herramientas) y uno más barato para tareas simples (mapear columnas)
export const MODELS = { chat: "gemini-3.6-flash", light: "gemini-3.5-flash-lite" } as const

// USD por millón de tokens (precio estándar de pago). Verificado en ai.google.dev/gemini-api/docs/pricing
// el 16-oct-2026. ponytail: en código; si Google cambia precios, se actualiza aquí.
const PRICES: Record<string, { input: number; output: number }> = {
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
}

export type AiBudget = { monthlyUsd: number; alertPercent: number; alertedMonth: string | null }
const DEFAULT_BUDGET: AiBudget = { monthlyUsd: 10, alertPercent: 80, alertedMonth: null }

export class AiPausedError extends Error {}

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7) // "2026-10" (UTC)
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))

export const costOf = (model: string, input: number, output: number) => {
  const p = PRICES[model] ?? PRICES[MODELS.chat]!
  return (input * p.input + output * p.output) / 1_000_000
}

export async function getAiBudget(): Promise<AiBudget> {
  const row = await prismaRoot.platformSetting.findUnique({ where: { key: "aiBudget" } })
  return { ...DEFAULT_BUDGET, ...((row?.value as Partial<AiBudget>) ?? {}) }
}

export async function setAiBudget(input: { monthlyUsd: number; alertPercent: number }) {
  const current = await getAiBudget()
  // al subir el presupuesto, si ya no se está sobre el umbral, se puede volver a avisar este mes
  const value = { ...current, ...input, alertedMonth: null }
  await prismaRoot.platformSetting.upsert({ where: { key: "aiBudget" }, create: { key: "aiBudget", value }, update: { value } })
  return value
}

export async function monthSpendUsd(d = new Date()) {
  const r = await prismaRoot.aiUsage.aggregate({ where: { createdAt: { gte: monthStart(d) } }, _sum: { costUsd: true } })
  return Number(r._sum.costUsd ?? 0)
}

export async function assertAiAvailable() {
  const [budget, spent] = await Promise.all([getAiBudget(), monthSpendUsd()])
  if (spent >= budget.monthlyUsd) {
    throw new AiPausedError("La IA está en pausa este mes: se alcanzó el presupuesto de la plataforma. Vuelve el 1 del mes próximo.")
  }
}

// Anota una consulta y, si el gasto del mes cruzó el umbral, avisa una vez a los dueños de la plataforma
export async function recordAiUsage(feature: AiFeature, model: string, inputTokens: number, outputTokens: number, userId?: string) {
  await prismaRoot.aiUsage.create({
    data: {
      companyId: currentCompanyIdOrNull(),
      userId: userId ?? null,
      feature,
      model,
      inputTokens,
      outputTokens,
      costUsd: new Prisma.Decimal(costOf(model, inputTokens, outputTokens).toFixed(6)),
    },
  })
  const [budget, spent] = await Promise.all([getAiBudget(), monthSpendUsd()])
  const month = monthKey()
  if (budget.alertedMonth !== month && spent >= (budget.monthlyUsd * budget.alertPercent) / 100) {
    await prismaRoot.platformSetting.upsert({
      where: { key: "aiBudget" },
      create: { key: "aiBudget", value: { ...budget, alertedMonth: month } },
      update: { value: { ...budget, alertedMonth: month } },
    })
    const owners = await prismaRoot.membership.findMany({
      where: { user: { isPlatformOwner: true, isActive: true } },
      select: { userId: true, companyId: true },
    })
    await prismaRoot.notification.createMany({
      data: owners.map((o) => ({
        userId: o.userId, companyId: o.companyId, type: "aiBudgetAlert", title: "",
        link: "/platform?tab=ai", meta: { spent: Number(spent.toFixed(2)), budget: budget.monthlyUsd, percent: budget.alertPercent },
      })),
    })
  }
}

// Llamada medida: presupuesto → Gemini → medidor
export async function generateMetered(
  feature: AiFeature,
  params: GenerateContentParameters,
  userId?: string
): Promise<GenerateContentResponse> {
  await assertAiAvailable()
  const response = await ai.models.generateContent(params)
  const u = response.usageMetadata
  await recordAiUsage(
    feature,
    params.model,
    u?.promptTokenCount ?? 0,
    (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0),
    userId
  )
  return response
}

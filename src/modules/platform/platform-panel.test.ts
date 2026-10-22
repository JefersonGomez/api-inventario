// Bloque 6A: panel del dueño — actividad, registros por semana, medidor de IA con presupuesto y sus acciones
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { assertAiAvailable, costOf, recordAiUsage, AiPausedError } from "../ai/ai.service.ts"
import { runWithCompany } from "../../shared/tenant.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Panel de plataforma: actividad y medidor de IA", () => {
  let owner: User, client: User

  beforeAll(async () => {
    await resetDb()
    owner = await createUser("ADMIN")
    await prisma.user.update({ where: { id: owner.user.id }, data: { isPlatformOwner: true } })
    client = await createUser("ADMIN")
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("costo estimado por modelo (USD por millón de tokens)", () => {
    expect(costOf("gemini-3.6-flash", 1_000_000, 0)).toBeCloseTo(1.5)
    expect(costOf("gemini-3.6-flash", 0, 1_000_000)).toBeCloseTo(7.5)
    expect(costOf("gemini-3.5-flash-lite", 2000, 500)).toBeCloseTo(0.0006 + 0.00125)
  })

  it("el medidor anota cada consulta por empresa; al llegar al umbral avisa una vez y al pasar el presupuesto pausa la IA", async () => {
    await request(app).put("/platform/ai-budget").set(owner.auth).send({ monthlyUsd: 1, alertPercent: 50 })
    // 40 % del presupuesto: sin aviso
    await runWithCompany(client.companyId, () => recordAiUsage("CHAT", "gemini-3.6-flash", 100_000, 33_333, client.user.id))
    const alerts = () => prisma.notification.count({ where: { userId: owner.user.id, type: "aiBudgetAlert" } })
    expect(await alerts()).toBe(0)
    // pasa el 50 %: avisa al dueño (una sola vez en el mes)
    await runWithCompany(client.companyId, () => recordAiUsage("IMPORT", "gemini-3.6-flash", 100_000, 10_000))
    await runWithCompany(client.companyId, () => recordAiUsage("IMPORT", "gemini-3.6-flash", 10_000, 1_000))
    expect(await alerts()).toBe(1)
    await expect(assertAiAvailable()).resolves.toBeUndefined()

    // pasa el presupuesto: la IA queda en pausa y el asistente responde 503 sin llamar a Gemini
    await runWithCompany(client.companyId, () => recordAiUsage("CHAT", "gemini-3.6-flash", 0, 100_000))
    await expect(assertAiAvailable()).rejects.toBeInstanceOf(AiPausedError)
    const chat = await request(app).post("/assistant/chat").set(client.auth).send({ message: "¿Qué tengo bajo mínimo?" })
    expect(chat.status).toBe(503)
    expect(chat.body.error).toMatch(/en pausa/)

    const report = (await request(app).get("/platform/ai-usage").set(owner.auth)).body
    expect(report).toMatchObject({ calls: 4, paused: true, budget: { monthlyUsd: 1, alertPercent: 50 } })
    expect(report.byCompany).toEqual([expect.objectContaining({ companyId: client.companyId, calls: { CHAT: 2, IMPORT: 2 } })])
    expect(report.spentUsd).toBeGreaterThan(1)
    // otro mes, vacío
    expect((await request(app).get("/platform/ai-usage?month=2020-01").set(owner.auth)).body.calls).toBe(0)

    // subir el presupuesto reactiva la IA
    await request(app).put("/platform/ai-budget").set(owner.auth).send({ monthlyUsd: 50, alertPercent: 80 })
    await expect(assertAiAvailable()).resolves.toBeUndefined()
  })

  it("actividad por empresa, registros por semana y registro de acciones del dueño", async () => {
    await prisma.stockMovement.create({
      data: {
        companyId: client.companyId, userId: client.user.id, type: "IN", quantity: 1, locationId: await mainLocationId(client.companyId),
        productId: (await prisma.product.create({ data: { companyId: client.companyId, sku: "X", name: "X", price: 1, categoryId: (await prisma.category.create({ data: { companyId: client.companyId, name: "C" } })).id } })).id,
      },
    })
    const overview = (await request(app).get("/platform/overview").set(owner.auth)).body
    expect(overview.activity.find((a: { companyId: string }) => a.companyId === client.companyId)).toMatchObject({ movementsWeek: 1, salesMonth: 0, ticketsMonth: 0, registers: 0 })
    expect(overview.signups).toHaveLength(12)
    expect(overview.signups.at(-1).count).toBe(2) // las dos empresas de este test, esta semana

    await request(app).patch(`/platform/companies/${client.companyId}/plan`).set(owner.auth).send({ plan: "PRO" })
    const actions = (await request(app).get("/platform/actions").set(owner.auth)).body
    expect(actions.map((a: { changes: { plan?: string; monthlyUsd?: number } }) => a.changes.plan ?? a.changes.monthlyUsd)).toEqual(expect.arrayContaining(["PRO", 50]))

    // nada de esto para un cliente
    for (const path of ["/platform/overview", "/platform/ai-usage", "/platform/actions"]) {
      expect((await request(app).get(path).set(client.auth)).status).toBe(403)
    }
    expect((await request(app).put("/platform/ai-budget").set(client.auth).send({ monthlyUsd: 1, alertPercent: 50 })).status).toBe(403)
  })
})

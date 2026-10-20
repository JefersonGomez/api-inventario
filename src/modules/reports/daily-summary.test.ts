// Bloque 6D: resumen del día — números del servidor, la IA solo redacta; uno por día y guardado
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { setSummaryWriterForTests } from "./daily-summary.service.ts"

describe("Resumen del día", () => {
  let admin: Awaited<ReturnType<typeof createUser>>
  const prompts: string[] = []
  let fail = false
  setSummaryWriterForTests(async (prompt) => {
    prompts.push(prompt)
    if (fail) throw new Error("IA caída")
    return "- Hubo 1 entrada hoy.\n- Revisa el stock bajo."
  })
  const today = new Date().toISOString().slice(0, 10)
  const qs = `?date=${today}&since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "General" } })
    await request(app).post("/products").set(admin.auth).send({ sku: "A", name: "A", price: 100, stock: 2, minStock: 5, categoryId: category.id })
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("sin generar todavía: GET no gasta y devuelve null", async () => {
    expect((await request(app).get(`/reports/daily-summary${qs}`).set(admin.auth)).body).toBeNull()
    expect(prompts).toHaveLength(0)
  })

  it("si la IA falla, devuelve los números sin texto y no guarda", async () => {
    fail = true
    const res = await request(app).post(`/reports/daily-summary${qs}`).set(admin.auth)
    expect(res.body).toMatchObject({ text: null, data: { lowStock: 1, movements: { in: 1 } } })
    expect((await request(app).get(`/reports/daily-summary${qs}`).set(admin.auth)).body).toBeNull()
  })

  it("se genera una vez al día con los números del servidor y se reutiliza", async () => {
    fail = false
    const res = await request(app).post(`/reports/daily-summary${qs}`).set(admin.auth)
    expect(res.body.text).toMatch(/1 entrada/)
    expect(prompts.at(-1)).toContain("\"lowStock\":1")
    expect(prompts.at(-1)).not.toMatch(/cost/i) // sin costos: lo ve cualquiera con reports.view
    const calls = prompts.length
    await request(app).post(`/reports/daily-summary${qs}`).set(admin.auth)
    expect((await request(app).get(`/reports/daily-summary${qs}`).set(admin.auth)).body.text).toMatch(/1 entrada/)
    expect(prompts).toHaveLength(calls)

    // volver a generar: guarda otro y quedan los dos en el historial
    const again = await request(app).post(`/reports/daily-summary${qs}&force=1`).set(admin.auth)
    expect(prompts).toHaveLength(calls + 1)
    expect(again.body.id).not.toBe(res.body.id)
    const history = (await request(app).get("/reports/daily-summaries").set(admin.auth)).body
    expect(history.total).toBe(2)
    expect(history.items[0].id).toBe(again.body.id)
    expect((await request(app).get(`/reports/daily-summaries?all=1&from=${today}&to=${today}`).set(admin.auth)).body).toHaveLength(2)
    expect((await request(app).get("/reports/daily-summaries?from=2000-01-01&to=2000-12-31").set(admin.auth)).body.total).toBe(0)

    const cashier = await createUser("CASHIER", admin.companyId)
    expect((await request(app).post(`/reports/daily-summary${qs}`).set(cashier.auth)).status).toBe(403)
  })
})

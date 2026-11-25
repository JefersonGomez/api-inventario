// Fase de cobro C1: prueba gratis, elegir plan y periodo, días de gracia y solo lectura al vencer
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"
import { subscriptionState } from "./billing.state.ts"

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const inDays = (days: number) => new Date(Date.now() + days * DAY)

describe("estado de la suscripción (solo fechas)", () => {
  const now = new Date("2026-12-01T12:00:00Z")
  const at = (iso: string) => new Date(iso)
  it("prueba, al día, gracia, vencida y exenta", () => {
    expect(subscriptionState({ trialEndsAt: at("2026-12-10T12:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "trial", daysLeft: 9 })
    expect(subscriptionState({ trialEndsAt: at("2026-11-01T00:00:00Z"), paidUntil: at("2026-12-31T00:00:00Z"), exempt: false }, now)).toMatchObject({ state: "active", daysLeft: 30 })
    // venció hace 1 día → 2 días de gracia
    expect(subscriptionState({ trialEndsAt: at("2026-11-30T12:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "grace", daysLeft: 2 })
    // la gracia cuenta desde lo último que tenía: un periodo pagado que venció después de la prueba
    expect(subscriptionState({ trialEndsAt: at("2026-10-01T00:00:00Z"), paidUntil: at("2026-11-30T00:00:00Z"), exempt: false }, now).state).toBe("grace")
    expect(subscriptionState({ trialEndsAt: at("2026-11-20T00:00:00Z"), paidUntil: null, exempt: false }, now)).toMatchObject({ state: "expired", daysLeft: 0 })
    expect(subscriptionState({ trialEndsAt: at("2020-01-01T00:00:00Z"), paidUntil: null, exempt: true }, now).state).toBe("exempt")
  })
})

describe("suscripción de la cuenta", () => {
  beforeEach(async () => {
    await resetDb()
  })
  afterEach(() => {
    delete process.env.BILLING_ENABLED
  })
  afterAll(async () => {
    await resetDb()
  })

  it("GET /plans publica los precios y los días de prueba", async () => {
    const res = await request(app).get("/plans")
    expect(res.body.find((p: { code: string }) => p.code === "BASIC")).toMatchObject({ prices: { monthly: 14900, annual: 12400 }, trialDays: 14 })
  })

  it("apagado (sin BILLING_ENABLED) nadie vence ni se bloquea", async () => {
    const admin = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: ago(30) } })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ enabled: false, isOwner: true, plan: "BASIC" })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Tornillos" })).status).toBe(201)
  })

  it("registrarse empieza la prueba de 14 días del plan elegido", async () => {
    process.env.BILLING_ENABLED = "1"
    await request(app).post("/auth/register").send({ acceptTerms: true, name: "Ana", email: "ana@prueba.cr", password: "Clave-segura-1", plan: "INVOICING" })
    const login = await request(app).post("/auth/login").send({ email: "ana@prueba.cr", password: "Clave-segura-1" })
    const auth = { Authorization: `Bearer ${login.body.accessToken ?? login.body.token}` }
    const sub = await request(app).get("/billing/subscription").set(auth)
    expect(sub.body).toMatchObject({ enabled: true, isOwner: true, plan: "INVOICING", interval: "MONTHLY", state: "trial", daysLeft: 14 })
    expect(sub.body.prices.INVOICING).toEqual({ monthly: 5900, annual: 4900 })
  })

  it("una cuenta de antes del cobro empieza su prueba la primera vez que se mira", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    expect(await prisma.subscription.count({ where: { userId: admin.user.id } })).toBe(0)
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "trial", daysLeft: 14 })
    expect(await prisma.subscription.count({ where: { userId: admin.user.id } })).toBe(1)
  })

  it("solo el dueño elige plan y periodo; los demás ven el estado", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    const cashier = await createUser("CASHIER", admin.companyId)
    const res = await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "PRO", interval: "ANNUAL" })
    expect(res.body).toMatchObject({ plan: "PRO", interval: "ANNUAL", state: "trial" })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).plan).toBe("PRO")
    expect((await request(app).get("/billing/subscription").set(cashier.auth)).body).toMatchObject({ isOwner: false, plan: "PRO", state: "trial" })
    expect((await request(app).put("/billing/subscription").set(cashier.auth).send({ plan: "BASIC" })).body.code).toBe("BILLING_OWNER_ONLY")
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({})).status).toBe(400)
    // con un periodo pagado vigente el cambio es de la fase C5
    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { paidUntil: inDays(20) } })
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "BASIC" })).body.code).toBe("BILLING_PAID_CHANGE")
  })

  it("al vencer: 3 días de gracia con todo funcionando, después solo lectura", async () => {
    process.env.BILLING_ENABLED = "1"
    const admin = await createUser("ADMIN")
    const cashier = await createUser("CASHIER", admin.companyId)
    await prisma.subscription.create({ data: { userId: admin.user.id, trialEndsAt: ago(1) } })
    expect((await request(app).get("/billing/subscription").set(admin.auth)).body).toMatchObject({ state: "grace", daysLeft: 2 })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "En gracia" })).status).toBe(201)

    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { trialEndsAt: ago(4) } })
    const blocked = await request(app).post("/categories").set(admin.auth).send({ name: "Vencida" })
    expect(blocked.status).toBe(402)
    expect(blocked.body.code).toBe("SUBSCRIPTION_EXPIRED")
    // a toda la empresa, no solo al dueño
    expect((await request(app).post("/categories").set(cashier.auth).send({ name: "Vencida 2" })).status).toBe(402)
    // ver y exportar sigue
    expect((await request(app).get("/categories").set(admin.auth)).status).toBe(200)
    // y puede elegir plan para pagar
    expect((await request(app).put("/billing/subscription").set(admin.auth).send({ plan: "BASIC" })).status).toBe(200)

    // pagó (C2 lo hará solo): vuelve a funcionar
    await prisma.subscription.update({ where: { userId: admin.user.id }, data: { paidUntil: inDays(30) } })
    expect((await request(app).post("/categories").set(admin.auth).send({ name: "Al día" })).status).toBe(201)
  })

  it("la demo y las cuentas internas nunca vencen", async () => {
    process.env.BILLING_ENABLED = "1"
    const demo = await createUser("ADMIN")
    await prisma.user.update({ where: { id: demo.user.id }, data: { isDemo: true } })
    expect((await request(app).get("/billing/subscription").set(demo.auth)).body.state).toBe("exempt")
    expect((await request(app).post("/categories").set(demo.auth).send({ name: "Demo" })).status).toBe(201)

    const internal = await createUser("ADMIN")
    await prisma.subscription.create({ data: { userId: internal.user.id, trialEndsAt: ago(100), exempt: true } })
    expect((await request(app).post("/categories").set(internal.auth).send({ name: "Interna" })).status).toBe(201)
  })
})

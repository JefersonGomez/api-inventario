// D4: la demo pública se crea con ventas reales, se reinicia sin tocar a las demás empresas,
// se entra sin contraseña solo si está activa y sus cuentas no se pueden bloquear
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDemo } from "./demo.service.ts"

describe("Demo pública", () => {
  let realCompanyId: string

  beforeAll(async () => {
    await resetDb()
    const real = await createUser("ADMIN")
    realCompanyId = real.companyId
    const category = await prisma.category.create({ data: { companyId: realCompanyId, name: "Mía" } })
    await prisma.product.create({ data: { companyId: realCompanyId, sku: "MIO", name: "Producto real", price: 100, categoryId: category.id } })
  }, 60_000)

  afterAll(async () => {
    delete process.env.DEMO_ENABLED
    await resetDb()
    await prisma.$disconnect()
  })

  it("crea la ferretería con ventas, y al reiniciarla no toca a las demás empresas", async () => {
    await resetDemo({ days: 4 })
    await resetDemo({ days: 4 }) // dos veces: queda una sola demo
    const demos = await prisma.company.findMany({ where: { isDemo: true } })
    expect(demos).toHaveLength(1)
    const cid = demos[0]!.id
    expect(await prisma.user.count({ where: { isDemo: true } })).toBe(4)
    expect(await prisma.product.count({ where: { companyId: cid } })).toBeGreaterThan(40)
    expect(await prisma.document.count({ where: { companyId: cid, type: { in: ["TICKET", "INVOICE"] } } })).toBeGreaterThan(5)
    // las ventas quedaron en días pasados, no hoy
    const latest = await prisma.document.findFirst({ where: { companyId: cid }, orderBy: { issuedAt: "desc" } })
    expect(latest!.issuedAt.toLocaleDateString("sv")).not.toBe(new Date().toLocaleDateString("sv"))
    expect(await prisma.product.count({ where: { companyId: realCompanyId } })).toBe(1)
  }, 180_000)

  it("se entra sin contraseña solo con DEMO_ENABLED=1; las cuentas demo no se pueden bloquear", async () => {
    delete process.env.DEMO_ENABLED
    expect((await request(app).get("/auth/demo")).body).toEqual({ enabled: false })
    expect((await request(app).post("/auth/demo").send({ role: "ADMIN" })).status).toBe(404)

    process.env.DEMO_ENABLED = "1"
    expect((await request(app).get("/auth/demo")).body).toMatchObject({ enabled: true, codes: { cashier: "2468", manager: "9753" } })
    const admin = await request(app).post("/auth/demo").send({ role: "ADMIN" })
    expect(admin.status).toBe(200)
    expect(admin.body).toMatchObject({ user: { isDemo: true, role: "ADMIN" }, company: { name: "Ferretería El Tornillo" } })
    const cashier = await request(app).post("/auth/demo").send({ role: "CASHIER" })
    expect(cashier.body.user).toMatchObject({ role: "CASHIER", email: "cajero@demo.stockly" })

    const auth = { Authorization: `Bearer ${admin.body.token}` }
    expect((await request(app).get("/auth/me").set(auth)).body.user).toMatchObject({ isDemo: true })
    const off = await request(app).patch(`/users/${cashier.body.user.id}/toggle-active`).set(auth)
    expect(off.body.error ?? off.body.message).toMatch(/demo/)
    expect((await request(app).put("/profile/me").set(auth).send({ name: "Otra", email: "otra@correo.com" })).body.error).toMatch(/demo/)
    expect((await request(app).put("/profile/me").set(auth).send({ name: "Ana", email: "admin@demo.stockly" })).status).toBe(200)
  }, 60_000)
})

// Fase 4 (8-nov-2026): "¿Cuánto retirar?" con el código del encargado y aviso del tope de efectivo
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { suggestedWithdrawal } from "./pos.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Caja: retiro sugerido y tope de efectivo", () => {
  let admin: User, manager: User, cashier: User
  let productId: string, managerPin: string
  const sell = (amount: number) =>
    request(app).post("/pos/sales").set(cashier.auth).send({ lines: [{ productId, quantity: amount / 1000 }], payments: [{ method: "CASH", amount }] })
  const alerts = () => prisma.notification.findMany({ where: { userId: manager.user.id, type: "cashOverLimit" } })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    const cashierPin = (await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })).body.pin
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    // precio 1000 con IVA exento: la venta de N unidades cobra N × 1000
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "SAC", name: "Saco", price: 1000, taxRate: "EXEMPT", stock: 1000, minStock: 0, categoryId: category.id, locationId: main })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: cashierPin, openingAmount: 50000 })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("redondea el retiro hacia abajo a ₡5 000 / $10 y deja el fondo + el sobrante", () => {
    expect(suggestedWithdrawal(187400, 50000, "CRC")).toMatchObject({ suggested: 135000, remaining: 52400 })
    expect(suggestedWithdrawal(52000, 50000, "CRC")).toMatchObject({ suggested: 0, remaining: 52000 })
    expect(suggestedWithdrawal(40000, 50000, "CRC")).toMatchObject({ suggested: 0 })
    expect(suggestedWithdrawal(437.5, 100, "USD")).toMatchObject({ suggested: 330, remaining: 107.5 })
  })

  it("el cajero ve el efectivo solo con el código del encargado; el encargado lo ve directo", async () => {
    await sell(87000)
    const blind = await request(app).post("/pos/session/cash-advice").set(cashier.auth).send({})
    expect(blind.status).toBe(409)
    expect(blind.body.code).toBe("ADVICE_NEEDS_AUTH")
    // su propio código no sirve (no hace arqueos)
    expect((await request(app).post("/pos/session/cash-advice").set(cashier.auth).send({ managerPin: "4821" })).status).toBe(403)
    const ok = await request(app).post("/pos/session/cash-advice").set(cashier.auth).send({ managerPin })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ expectedCash: 137000, openingAmount: 50000, suggested: 85000, remaining: 52000, authorizedBy: { id: manager.user.id } })
    // queda la autorización en la auditoría
    expect(await prisma.auditLog.count({ where: { action: "AUTHORIZE", userId: manager.user.id } })).toBeGreaterThan(0)
  })

  it("avisa una vez al pasar el tope, se rearma con un retiro y vuelve a avisar", async () => {
    expect((await request(app).put("/company").set(admin.auth).send({ cashLimit: 200000 })).status).toBe(200)
    await sell(50000) // 187 000: todavía no
    expect(await alerts()).toHaveLength(0)
    await sell(20000) // 207 000: pasa
    await sell(5000) // sigue arriba: no repite
    const first = await alerts()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ title: "Caja 1", link: "/cash-closings", meta: { cash: 207000, limit: 200000, cashier: cashier.user.name } })

    // el retiro sugerido baja la caja y rearma el aviso
    expect((await request(app).post("/pos/session/movements").set(cashier.auth).send({ type: "OUT", amount: 160000, reason: "Retiro a caja fuerte" })).status).toBe(201)
    expect((await prisma.cashSession.findFirst({ where: { openedById: cashier.user.id, status: "OPEN" } }))?.overLimitAt).toBeNull()
    await sell(150000) // 202 000: pasa otra vez
    expect(await alerts()).toHaveLength(2)

    // sin tope no hay aviso
    expect((await request(app).put("/company").set(admin.auth).send({ cashLimit: null })).status).toBe(200)
    expect((await request(app).get("/company").set(admin.auth)).body.cashLimit).toBeNull()
  })
})

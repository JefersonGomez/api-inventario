// Bloque 7B-2: venta a crédito con cuotas, abonos en caja y sin caja, bloqueos y aviso de vencidas
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { buildInstallments, dueDates, notifyOverdue } from "./receivables.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Crédito y cuentas por cobrar", () => {
  let admin: User, manager: User, cashier: User
  let productId: string, customerId: string, managerPin: string
  const sell = (body: object) => request(app).post("/pos/sales").set(cashier.auth).send(body)
  const pay = (u: User, body: object) => request(app).post("/receivables/payments").set(u.auth).send({ customerId, ...body })
  const account = async () => (await request(app).get(`/receivables/${customerId}`).set(cashier.auth)).body

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "ARZ", name: "Arroz", price: 1130, stock: 20, minStock: 0, categoryId: category.id, locationId: main })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
    customerId = (await request(app).post("/customers").set(cashier.auth).send({ name: "Ana Mora", idType: "FISICA", idNumber: "101110111" })).body.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cuotas: cada 15 días o el mismo día de cada mes, iguales y la última con los centavos", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`)
    expect(dueDates({ frequency: "MONTHLY", installments: 3 }, d("2026-01-31")).map((x) => x.toISOString().slice(0, 10))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"])
    expect(dueDates({ frequency: "BIWEEKLY", installments: 2 }, d("2026-10-20")).map((x) => x.toISOString().slice(0, 10))).toEqual(["2026-11-04", "2026-11-19"])
    expect(buildInstallments(new Prisma.Decimal(1000), { frequency: "MONTHLY", installments: 3 }).map((i) => i.amount.toNumber())).toEqual([333.33, 333.33, 333.34])
  })

  it("venta a crédito: cliente habilitado, código del encargado, límite y prima", async () => {
    // 2 × 1130 = 2260: 260 de prima en efectivo y 2000 en 2 cuotas mensuales
    const body = {
      customerId, lines: [{ productId, quantity: 2 }], payments: [{ method: "CASH", amount: 260 }],
      credit: { frequency: "MONTHLY", installments: 2 },
    }
    expect((await sell({ ...body, creditPin: managerPin })).body.code).toBe("CREDIT_CUSTOMER") // sin crédito todavía
    await request(app).put(`/receivables/${customerId}/credit`).set(admin.auth).send({ creditLimit: 3000 })
    expect((await sell(body)).body.code).toBe("CREDIT_NEEDS_AUTH")
    expect((await sell({ ...body, creditPin: "4821" })).body.code).toBe("CREDIT_PIN") // el cajero no autoriza
    expect((await sell({ ...body, credit: { frequency: "MONTHLY", installments: 7 }, creditPin: managerPin })).status).toBe(400) // más de 6 meses

    const res = await sell({ ...body, creditPin: managerPin })
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ type: "INVOICE", saleCondition: "CREDIT", creditAuthorizedBy: { id: manager.user.id } })
    expect(res.body.document.installments.map((i: { amount: number }) => i.amount)).toEqual([1000, 1000])
    expect(await account()).toMatchObject({ creditLimit: 3000, balance: 2000, available: 1000, overdueCount: 0 })

    // la segunda pasa el límite: no se vende y no sale stock
    const over = await sell({ ...body, creditPin: managerPin })
    expect(over.body.code).toBe("CREDIT_LIMIT")
    expect(over.body.error).toMatch(/1000\.00 disponibles/)
  })

  it("abonos: en la caja entra al arqueo; sin caja con referencia; a la cuota más vieja primero", async () => {
    const atRegister = await pay(cashier, { amount: 1200, method: "CASH", tendered: 1500, inRegister: true })
    expect(atRegister.status).toBe(201)
    expect(atRegister.body.payment).toMatchObject({ balanceBefore: 2000, balanceAfter: 800 })
    expect((await account()).installments.map((i: { paid: number }) => i.paid).sort()).toEqual([1000, 200].sort())
    const session = (await request(app).get("/pos/session").set(manager.auth)).body
    expect(session).toBeNull() // el encargado no tiene caja abierta
    const mine = (await request(app).get("/pos/session").set(cashier.auth)).body
    expect(mine.summary).toMatchObject({ collections: { CASH: 1200 }, collectionsCount: 1 })

    expect((await pay(cashier, { amount: 900, method: "CASH", inRegister: true })).body.error).toMatch(/supera el saldo/)
    expect((await pay(cashier, { amount: 100, method: "TRANSFER", reference: "123", inRegister: false })).status).toBe(403)
    expect((await pay(manager, { amount: 100, method: "TRANSFER", inRegister: false })).body.error).toMatch(/referencia/)
    const off = await pay(manager, { amount: 800, method: "TRANSFER", reference: "BN-5521", inRegister: false })
    expect(off.body.payment).toMatchObject({ balanceAfter: 0, cashSessionId: null })
    expect((await request(app).get(`/receivables/payments/${off.body.payment.id}`).set(cashier.auth)).body.payment.reference).toBe("BN-5521")
  })

  it("cuotas vencidas: bloquean el crédito y avisan una sola vez a quien cobra", async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { customerId, saleCondition: "CREDIT" } })
    await prisma.installment.create({
      data: { companyId: admin.companyId, customerId, documentId: doc.id, number: 9, frequency: "MONTHLY", dueDate: new Date("2026-01-01"), amount: 500 },
    })
    const res = await sell({ customerId, lines: [{ productId, quantity: 1 }], credit: { frequency: "BIWEEKLY", installments: 2 }, creditPin: managerPin })
    expect(res.body.code).toBe("CREDIT_OVERDUE")

    expect(await notifyOverdue()).toBe(1)
    expect(await notifyOverdue()).toBe(0)
    const notes = await prisma.notification.findMany({ where: { type: "installmentOverdue" } })
    expect(notes.map((n) => n.userId).sort()).toEqual([admin.user.id, manager.user.id].sort())

    // cuentas por cobrar: solo quien cobra; el cajero no
    expect((await request(app).get("/receivables").set(cashier.auth)).status).toBe(403)
    const list = (await request(app).get("/receivables?overdue=1").set(manager.auth)).body
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: customerId, balance: 500, overdue: 500, overdueCount: 1 })
  })
})

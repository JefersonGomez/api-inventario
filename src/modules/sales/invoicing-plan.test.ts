// Plan "Solo facturación" (facturación como servicio, 18-nov-2026): sin stock, sin cajas, cupo de comprobantes al mes
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { PLANS } from "../../config/plans.ts"
import { createUser, mainLocationId, resetDb } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Plan Solo facturación", () => {
  let admin: User
  let main: string, serviceId: string, customerId: string
  const invoice = (body: object = {}) =>
    request(app).post("/sales/invoices").set(admin.auth).send({
      customerId, lines: [{ productId: serviceId, quantity: 3 }], payment: { method: "TRANSFER" }, ...body,
    })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    await prisma.user.update({ where: { id: admin.user.id }, data: { plan: "INVOICING" } })
    main = await mainLocationId(admin.companyId)
    const categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "Servicios" } })).id
    // un producto del catálogo sin existencias: igual se factura
    serviceId = (await request(app).post("/products").set(admin.auth).send({
      sku: "CONS", name: "Hora de consultoría", price: 22600, cost: 0, stock: 0, minStock: 0, categoryId, cabys: "8399000000000", locationId: main,
    })).body.id
    customerId = (await request(app).post("/customers").set(admin.auth)
      .send({ name: "Inversiones del Valle S.A.", idType: "JURIDICA", idNumber: "3101654321" })).body.id
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("al registrarse se puede elegir solo facturación", async () => {
    const res = await request(app).post("/auth/register")
      .send({ name: "Laura", email: "laura@test.com", password: "Clave-segura-1", acceptTerms: true, plan: "INVOICING" })
    expect(res.status).toBe(201)
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "laura@test.com" } })).plan).toBe("INVOICING")
    // un plan que no existe en el registro (los pagos se eligen después)
    expect((await request(app).post("/auth/register")
      .send({ name: "Otro", email: "otro@test.com", password: "Clave-segura-1", acceptTerms: true, plan: "BUSINESS" })).status).toBe(400)
  })

  it("la empresa sabe que es solo facturación y cuánto cupo lleva", async () => {
    const res = await request(app).get("/company").set(admin.auth)
    expect(res.body.limits).toMatchObject({ invoicingOnly: true, documentsPerMonth: 100, maxRegistersPerBranch: 0 })
    expect(res.body.usage).toEqual({ documentsThisMonth: 0 })
  })

  it("facturar no mueve el stock (aunque no haya existencias)", async () => {
    const res = await invoice()
    expect(res.status).toBe(201)
    expect(await prisma.stockMovement.count({ where: { sourceId: res.body.document.id } })).toBe(0)
    expect((await request(app).get("/company").set(admin.auth)).body.usage).toEqual({ documentsThisMonth: 1 })
  })

  it("la nota de crédito la hace el administrador sin código de caja y no devuelve nada al stock", async () => {
    const sale = (await invoice()).body.document
    const res = await request(app).post(`/sales/${sale.id}/returns`).set(admin.auth).send({
      lines: [{ lineId: sale.lines[0].id, quantity: 1, condition: "GOOD" }],
      reason: "Se cobró una hora de más",
      refund: { method: "TRANSFER" },
    })
    expect(res.status).toBe(201)
    expect(res.body.document.type).toBe("CREDIT_NOTE")
    expect(await prisma.stockMovement.count({ where: { sourceId: res.body.document.id } })).toBe(0)
  })

  it("no deja abrir cajas", async () => {
    const res = await request(app).post("/pos/registers").set(admin.auth).send({ name: "Caja 1", locationId: main })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it("al llegar al cupo del mes no deja emitir más (las notas de crédito no cuentan)", async () => {
    const used = (await request(app).get("/company").set(admin.auth)).body.usage.documentsThisMonth
    expect(used).toBe(2) // dos facturas; la nota de crédito no gasta cupo
    // se llena el cupo con documentos del mes
    const sample = await prisma.document.findFirstOrThrow({ where: { companyId: admin.companyId, type: "INVOICE" } })
    const { id: _id, consecutive, number: _n, ...rest } = sample
    await prisma.document.createMany({
      data: Array.from({ length: PLANS.INVOICING.documentsPerMonth! - used }, (_, i) => ({
        ...rest, consecutive: `${consecutive.slice(0, 10)}${String(9_000_000 + i).padStart(10, "0")}`, number: 9_000_000 + i,
      })) as never,
    })
    const res = await invoice()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("PLAN_DOCUMENTS")
  })

  it("el plan completo sigue moviendo el stock como siempre", async () => {
    await prisma.user.update({ where: { id: admin.user.id }, data: { plan: "BASIC" } })
    const res = await invoice()
    expect(res.status).toBe(409) // sin existencias: el plan completo no deja facturar en negativo
    expect(res.body.code).toBe("INVOICE_STOCK")
  })
})

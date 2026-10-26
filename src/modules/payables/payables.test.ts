// Bloque 10 (punto 52): cuentas por pagar — facturas de proveedores al recibir o sueltas, pagos y avisos
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { notifyPayablesDue } from "./payables.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysFromToday = (n: number) => {
  const d = new Date()
  return ymd(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + n)))
}

describe("Cuentas por pagar", () => {
  let admin: User, accountant: User, employee: User
  let supplierId: string, productId: string

  const invoice = (body: object, who: User = admin) =>
    request(app).post("/payables/invoices").set(who.auth).send({ supplierId, issueDate: daysFromToday(0), ...body })
  const pay = (body: object, who: User = admin) => request(app).post("/payables/payments").set(who.auth).send({ supplierId, ...body })
  const account = async () => (await request(app).get(`/payables/${supplierId}`).set(admin.auth)).body

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    accountant = await createUser("ACCOUNTANT", admin.companyId)
    employee = await createUser("EMPLOYE", admin.companyId)
    const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "General" } })
    supplierId = (await request(app).post("/suppliers").set(admin.auth).send({ name: "Ferretera del Valle", creditDays: 30 })).body.id
    productId = (await request(app).post("/products").set(admin.auth).send({ sku: "CEM", name: "Cemento", price: 9000, stock: 0, minStock: 0, categoryId: category.id })).body.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("al recibir una orden se registra la factura con lo recibido + IVA y vence según los días del proveedor", async () => {
    const order = (await request(app).post("/purchase-orders").set(admin.auth).send({ supplierId, items: [{ productId, quantity: 10, unitCost: 5000 }] })).body
    const res = await request(app).patch(`/purchase-orders/${order.id}/receive`).set(admin.auth).send({ invoice: { number: "FAC-100", issueDate: daysFromToday(0) } })
    expect(res.status).toBe(200)

    const inv = await prisma.supplierInvoice.findFirstOrThrow({ where: { purchaseOrderId: order.id } })
    expect(inv).toMatchObject({ number: "FAC-100" })
    expect([Number(inv.subtotal), Number(inv.tax), Number(inv.total)]).toEqual([50000, 6500, 56500])
    expect(ymd(inv.dueDate)).toBe(daysFromToday(30))
    // el IVA queda por tarifa (el cemento es 13 %) y da crédito fiscal
    const taxes = await prisma.supplierInvoiceTax.findMany({ where: { invoiceId: inv.id } })
    expect(taxes.map((t) => [t.rate, Number(t.base), Number(t.tax)])).toEqual([["RATE_13", 50000, 6500]])
    expect(inv.creditable).toBe(true)
  })

  it("IVA por tarifa: calcula el que falta, respeta el que trae la factura y marca lo no acreditable", async () => {
    const res = await invoice({
      number: "MIX-1",
      creditable: false,
      lines: [{ rate: "RATE_13", base: 1000, tax: 131 }, { rate: "RATE_1", base: 500 }, { rate: "EXEMPT", base: 200 }],
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ creditable: false })
    expect([Number(res.body.subtotal), Number(res.body.tax), Number(res.body.total)]).toEqual([1700, 136, 1836])
    const taxes = await prisma.supplierInvoiceTax.findMany({ where: { invoiceId: res.body.id }, orderBy: { rate: "asc" } })
    expect(taxes.map((t) => [t.rate, Number(t.tax)])).toEqual(expect.arrayContaining([["RATE_13", 131], ["RATE_1", 5], ["EXEMPT", 0]]))

    expect((await invoice({ number: "MIX-2", lines: [{ rate: "RATE_13", base: 1 }, { rate: "RATE_13", base: 2 }] })).body.error).toBeDefined()
    expect((await invoice({ number: "MIX-3", lines: [{ rate: "EXEMPT", base: 100, tax: 13 }] })).status).toBe(400)
    // se anula para no mover los saldos de las pruebas de abajo
    await request(app).post(`/payables/invoices/${res.body.id}/void`).set(admin.auth).send({ reason: "prueba" })
  })

  it("un número repetido del mismo proveedor deshace toda la recepción", async () => {
    const order = (await request(app).post("/purchase-orders").set(admin.auth).send({ supplierId, items: [{ productId, quantity: 5, unitCost: 5000 }] })).body
    const res = await request(app).patch(`/purchase-orders/${order.id}/receive`).set(admin.auth).send({ invoice: { number: "FAC-100", issueDate: daysFromToday(0) } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/FAC-100.*ya está registrada/)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(10)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING")
  })

  it("factura suelta; el pago va de la que vence primero, pide referencia y no pasa del saldo", async () => {
    const flete = await invoice({ number: "F-7", lines: [{ rate: "RATE_13", base: 10000 }], dueDate: daysFromToday(5) }, accountant)
    expect(flete.status).toBe(201)
    expect((await account()).balance).toBe(56500 + 11300)

    expect((await pay({ amount: 1000, method: "TRANSFER" })).body.error).toMatch(/referencia/)
    expect((await pay({ amount: 999999, method: "CASH" })).body.error).toMatch(/supera el saldo/)

    // 20 000: cubre primero el flete (vence en 5 días) y el resto va a FAC-100 (vence en 30)
    const p = await pay({ amount: 20000, method: "TRANSFER", reference: "TRF-1" }, accountant)
    expect(p.status).toBe(201)
    expect(p.body.allocations.map((a: { amount: string; invoice: { number: string } }) => [a.invoice.number, Number(a.amount)]))
      .toEqual([["F-7", 11300], ["FAC-100", 8700]])
    expect((await account()).balance).toBe(56500 + 11300 - 20000)

    // pagar solo una factura elegida
    const other = await invoice({ number: "F-8", lines: [{ rate: "EXEMPT", base: 1000 }] })
    const only = await pay({ amount: 1000, method: "CASH", invoiceIds: [other.body.id] })
    expect(only.body.allocations).toHaveLength(1)
    expect((await pay({ amount: 1, method: "CASH", invoiceIds: [other.body.id] })).body.error).toMatch(/pagada o anulada/)
  })

  it("anular: solo sin pagos, y libera el número", async () => {
    const paid = await prisma.supplierInvoice.findFirstOrThrow({ where: { number: "FAC-100" } })
    expect((await request(app).post(`/payables/invoices/${paid.id}/void`).set(admin.auth).send({ reason: "error" })).body.error).toMatch(/tiene pagos/)

    const wrong = await invoice({ number: "F-9", lines: [{ rate: "RATE_13", base: 500 }] })
    expect((await request(app).post(`/payables/invoices/${wrong.body.id}/void`).set(admin.auth).send({ reason: "Monto mal digitado" })).status).toBe(200)
    expect((await invoice({ number: "F-9", lines: [{ rate: "RATE_13", base: 600 }] })).status).toBe(201)
    const voided = await request(app).get("/payables/invoices?status=void").set(admin.auth)
    expect(voided.body.items.map((i: { number: string }) => i.number).sort()).toEqual(["F-9", "MIX-1"])
  })

  it("saldos por proveedor con antigüedad de lo vencido", async () => {
    // emitida hace 40 días, de contado (vence ese día): 40 días de atraso → tramo 31–60
    const late = await invoice({ number: "F-OLD", lines: [{ rate: "EXEMPT", base: 2000 }], issueDate: daysFromToday(-40), dueDate: daysFromToday(-40) })
    expect(late.status).toBe(201)
    const res = await request(app).get("/payables?overdue=1").set(accountant.auth)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({ supplier: { id: supplierId }, overdue: 2000, aging: { d60: 2000 } })
    expect(res.body.totals.overdue).toBe(2000)
    const overdueList = await request(app).get("/payables/invoices?status=overdue").set(admin.auth)
    expect(overdueList.body.items.map((i: { number: string }) => i.number)).toEqual(["F-OLD"])
  })

  it("aviso en la campanita una vez por factura que vence en 3 días o menos", async () => {
    await invoice({ number: "F-SOON", lines: [{ rate: "EXEMPT", base: 3000 }], dueDate: daysFromToday(2) })
    await invoice({ number: "F-LATER", lines: [{ rate: "EXEMPT", base: 3000 }], dueDate: daysFromToday(20) })
    expect(await notifyPayablesDue()).toBe(2) // F-SOON y F-OLD (la vencida no tenía aviso)
    expect(await notifyPayablesDue()).toBe(0)
    const notes = await prisma.notification.findMany({ where: { type: "payableDue" } })
    expect(new Set(notes.map((n) => n.userId))).toEqual(new Set([admin.user.id, accountant.user.id]))
    expect(notes[0]).toMatchObject({ title: "Ferretera del Valle", link: `/payables/${supplierId}` })
  })

  it("permisos, aislamiento entre empresas y proveedor con facturas no se borra", async () => {
    expect((await request(app).get("/payables").set(employee.auth)).status).toBe(403)
    expect((await invoice({ number: "X", lines: [{ rate: "EXEMPT", base: 1 }] }, employee)).status).toBe(403)

    const other = await createUser("ADMIN")
    expect((await request(app).get(`/payables/${supplierId}`).set(other.auth)).status).toBe(404)
    expect((await request(app).get("/payables").set(other.auth)).body.total).toBe(0)
    expect((await pay({ amount: 1, method: "CASH" }, other)).status).toBe(404)

    expect((await request(app).delete(`/suppliers/${supplierId}`).set(admin.auth)).body.error).toMatch(/factura/)
  })
})

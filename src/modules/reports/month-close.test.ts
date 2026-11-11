// Paquete para el contador (parte B): cuentas por cobrar, por pagar e inventario AL CIERRE del mes
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>
const shift = (month: string, n: number) => {
  const d = new Date(`${month}-15T12:00:00`)
  d.setMonth(d.getMonth() + n)
  return d.toLocaleDateString("sv").slice(0, 7)
}

describe("Paquete para el contador: saldos al cierre del mes", () => {
  let admin: User
  let productId: string, customerId: string, supplierId: string
  const month = new Date().toLocaleDateString("sv").slice(0, 7)
  const next = shift(month, 1)
  const prev = shift(month, -1)
  const pkg = async (m: string) => (await request(app).get(`/reports/accountant-package?month=${m}`).set(admin.auth)).body

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    const manager = await createUser("MANAGER", c)
    const cashier = await createUser("CASHIER", c)
    const managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    await request(app).post(`/users/${cashier.user.id}/pin`).set(admin.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "ARZ", name: "Arroz", price: 1130, cost: 500, stock: 20, minStock: 0, categoryId: category.id, locationId: main })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
    customerId = (await request(app).post("/customers").set(admin.auth).send({ name: "Ana Mora", idType: "FISICA", idNumber: "101110111" })).body.id
    await request(app).put(`/receivables/${customerId}/credit`).set(admin.auth).send({ creditLimit: 5000 })

    // crédito: 2 × 1130 = 2260 → 260 de prima y 2000 en 2 cuotas de 1000
    const sale = await request(app).post("/pos/sales").set(cashier.auth).send({
      customerId, lines: [{ productId, quantity: 2 }], payments: [{ method: "CASH", amount: 260 }],
      credit: { frequency: "MONTHLY", installments: 2 }, creditPin: managerPin,
    })
    expect(sale.status).toBe(201)
    // la primera cuota venció 45 días antes del fin del mes
    const lastDay = new Date(`${next}-01T00:00:00Z`)
    lastDay.setUTCDate(0)
    await prisma.installment.updateMany({ where: { customerId, number: 1 }, data: { dueDate: new Date(lastDay.getTime() - 45 * 86_400_000) } })
    const pay = (amount: number, reference: string) => request(app).post("/receivables/payments").set(admin.auth)
      .send({ customerId, amount, method: "TRANSFER", reference, inRegister: false })
    expect((await pay(500, "T-1")).status).toBe(201)
    const late = (await pay(300, "T-2")).body.payment.id // se hizo el mes siguiente
    await prisma.customerPayment.update({ where: { id: late }, data: { createdAt: new Date(`${next}-05T12:00:00`) } })

    // por pagar: 10 000 exento, plazo 60 días; 4000 pagados en el mes y 1000 el mes siguiente
    supplierId = (await request(app).post("/suppliers").set(admin.auth).send({ name: "Distribuidora Sur", creditDays: 60 })).body.id
    const inv = await request(app).post("/payables/invoices").set(admin.auth)
      .send({ supplierId, number: "F-1", issueDate: new Date().toLocaleDateString("sv"), lines: [{ rate: "EXEMPT", base: 10000 }] })
    expect(inv.status).toBe(201)
    const supplierPay = (amount: number, reference: string) => request(app).post("/payables/payments").set(admin.auth)
      .send({ supplierId, amount, method: "TRANSFER", reference })
    expect((await supplierPay(4000, "P-1")).status).toBe(201)
    const later = (await supplierPay(1000, "P-2")).body
    await prisma.supplierPayment.updateMany({ where: { reference: "P-2" }, data: { paidAt: new Date(`${next}-05`) } })
    expect(later).toBeDefined()

    // inventario: 20 − 2 vendidas = 18; una salida de 3 el mes siguiente
    const out = await request(app).post("/movements").set(admin.auth).send({ productId, type: "OUT", quantity: 3, reason: "Uso" })
    await prisma.stockMovement.update({ where: { id: out.body.id }, data: { createdAt: new Date(`${next}-05T12:00:00`) } })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("por cobrar: lo emitido hasta el cierre menos los abonos hasta el cierre, con antigüedad", async () => {
    const p = await pkg(month)
    expect(p.closingDate).toMatch(new RegExp(`^${month}-\\d{2}$`))
    expect(p.receivables.customers).toHaveLength(1)
    // el abono de 500 cubre media cuota vencida; el de 300 fue después del cierre
    expect(p.receivables.customers[0]).toMatchObject({
      customer: { name: "Ana Mora" }, balance: 1500, overdue: 500, aging: { current: 1000, d31_60: 500 },
    })
    expect(p.receivables.totals).toMatchObject({ count: 1, balance: 1500, overdue: 500 })
    expect((await pkg(next)).receivables.totals.balance).toBe(1200)
    expect((await pkg(prev)).receivables.customers).toEqual([])
  })

  it("por pagar: facturas hasta el cierre menos los pagos hechos hasta el cierre", async () => {
    const p = await pkg(month)
    expect(p.payables.invoices).toEqual([expect.objectContaining({ number: "F-1", total: 10000, paid: 4000, balance: 6000, bucket: "current" })])
    expect(p.payables.totals).toMatchObject({ count: 1, balance: 6000, overdue: 0 })
    expect((await pkg(next)).payables.totals.balance).toBe(5000)
    expect((await pkg(prev)).payables.invoices).toEqual([])
  })

  it("inventario: cantidades repitiendo los movimientos hasta el cierre, al costo de la última venta", async () => {
    const [item] = (await pkg(month)).inventory.items
    expect(item).toMatchObject({ product: { sku: "ARZ" }, quantity: 18, unitCost: 500, costSource: "sale", value: 9000 })
    expect(item.byLocation).toEqual([expect.objectContaining({ quantity: 18 })])
    const after = (await pkg(next)).inventory
    expect(after.items[0].quantity).toBe(15)
    // el mes en curso termina igual que el stock de hoy
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(15)
    expect((await pkg(prev)).inventory).toMatchObject({ items: [], totals: { count: 0, value: 0 } })
  })
})

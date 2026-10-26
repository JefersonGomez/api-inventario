// Bloque 10 (punto 53B): conciliación — sugerencias, confirmar (con comisión de tarjeta) y deshacer
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>
type Suggestion = { type: string; id: string; amount: number }
type Row = { id: string; reference: string; suggestion: Suggestion | null; candidates: Suggestion[] }

const DAY = 86_400_000
const local = (offset = 0) => new Date(Date.now() + offset * DAY).toLocaleDateString("sv")

describe("Conciliación bancaria", () => {
  let admin: User, cashier: User
  let accountId: string, supplierId: string
  const rows = new Map<string, string>() // referencia del banco → id del movimiento

  const reconcile = async (who: User = admin) =>
    (await request(app).get(`/banks/accounts/${accountId}/reconcile?from=${local(-12)}&to=${local(1)}`).set(who.auth)).body as { items: Row[]; missing: Suggestion[]; total: number; suggested: number }
  const match = (ref: string, items: object[], who: User = admin) =>
    request(app).post(`/banks/transactions/${rows.get(ref)}/match`).set(who.auth).send({ items })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    const main = await mainLocationId(c)
    const manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })
    await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    const productId = (await request(app).post("/products").set(admin.auth).send({ sku: "ARZ", name: "Arroz", price: 1130, stock: 50, minStock: 0, categoryId: category.id, locationId: main })).body.id
    const registerId = (await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })).body.id
    await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "4821", openingAmount: 0 })
    // la cuenta recibe el SINPE y la tarjeta de la empresa y de la sucursal principal
    accountId = (await request(app).post("/banks/accounts").set(admin.auth).send({ name: "BN", bankName: "Banco Nacional", currency: "CRC", general: true, locationIds: [main] })).body.id

    const sell = (qty: number, method: string, reference: string) =>
      request(app).post("/pos/sales").set(cashier.auth).send({ lines: [{ productId, quantity: qty }], payments: [{ method, amount: 1130 * qty, reference }] })
    expect((await sell(1, "SINPE", "51604453")).status).toBe(201)
    await sell(1, "CARD", "AUT1")
    await sell(2, "CARD", "AUT2") // tarjeta del día: 3390

    supplierId = (await request(app).post("/suppliers").set(admin.auth).send({ name: "Ferretera" })).body.id
    await request(app).post("/payables/invoices").set(admin.auth).send({ supplierId, number: "F1", issueDate: local(-20), subtotal: 20000, tax: 0 })
    await request(app).post("/payables/payments").set(admin.auth).send({ supplierId, amount: 5000, method: "TRANSFER", reference: "T-9" })
    // pagado hace 10 días y nunca salió del banco
    await request(app).post("/payables/payments").set(admin.auth).send({ supplierId, amount: 700, method: "TRANSFER", reference: "T-OLD", paidAt: local(-10) })
    await request(app).post("/banks/deposits").set(admin.auth).send({ bankAccountId: accountId, amount: 10000, depositedAt: local(), reference: "DEP1" })

    // el estado del banco (datos inventados)
    const bank = [
      { date: local(), reference: "51604453", description: "TRANSFERENCIA SINPE/CLIENTE UNO", amount: 1130 },
      { date: local(), reference: "999", description: "SIMPE 88887777/OTRO", amount: 1130 },
      { date: local(1), reference: "77", description: "LIQUIDACION DATAFONO", amount: 3305.25 }, // 2,5 % de comisión
      { date: local(), reference: "123", description: "TRANSF A FERRETERA", amount: -5000 },
      { date: local(), reference: "4", description: "DEPOSITO/VENTAS", amount: 10000 },
      { date: local(), reference: "5", description: "COMISION", amount: -675 },
    ]
    await request(app).post(`/banks/accounts/${accountId}/import`).set(admin.auth).send({ fileName: "estado.csv", rows: bank })
    for (const t of await prisma.bankTransaction.findMany({ where: { bankAccountId: accountId } })) rows.set(t.reference, t.id)
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("sugiere parejas: la referencia gana, la tarjeta del día con su comisión, pagos y depósitos", async () => {
    const r = await reconcile()
    const by = new Map(r.items.map((t) => [t.reference, t]))
    expect(by.get("51604453")!.suggestion).toMatchObject({ type: "SALE_PAYMENT", amount: 1130 })
    expect(by.get("999")!.suggestion).toBeNull() // el mismo monto, pero la venta ya es del otro
    expect(by.get("999")!.candidates).toHaveLength(1)
    expect(by.get("77")!.suggestion).toMatchObject({ type: "CARD_BATCH", amount: 3390 })
    expect(by.get("123")!.suggestion).toMatchObject({ type: "SUPPLIER_PAYMENT", amount: -5000 })
    expect(by.get("4")!.suggestion).toMatchObject({ type: "CASH_DEPOSIT", amount: 10000 })
    expect(by.get("5")!.suggestion).toBeNull()
    expect(r).toMatchObject({ total: 6, suggested: 4 })
    // en el sistema y no en el banco: el pago de hace 10 días
    expect(r.missing).toEqual([expect.objectContaining({ type: "SUPPLIER_PAYMENT", amount: -700 })])
  })

  it("confirmar: cada cosa del sistema se concilia una vez; la tarjeta guarda la comisión", async () => {
    const r = await reconcile()
    const s = (ref: string) => r.items.find((t) => t.reference === ref)!.suggestion!
    expect((await match("51604453", [s("51604453")])).status).toBe(200)
    expect((await match("999", [s("51604453")])).body.error).toMatch(/ya está conciliado/)

    const card = await match("77", [s("77")])
    expect(card.status).toBe(200)
    expect(Number(card.body.fee)).toBe(84.75)

    // no cuadra: el pago al proveedor no es el depósito
    expect((await match("123", [s("4")])).body.error).toMatch(/No cuadra/)
    expect((await match("123", [s("123")])).status).toBe(200)

    const list = await request(app).get(`/banks/accounts/${accountId}/transactions?status=reviewed`).set(admin.auth)
    expect(list.body.items.find((t: { reference: string }) => t.reference === "77").matches).toEqual([expect.objectContaining({ sourceType: "CARD_BATCH", label: local() })])
    // conciliado: no se clasifica encima
    expect((await request(app).patch(`/banks/transactions/${rows.get("77")}`).set(admin.auth).send({ category: "OTHER" })).body.error).toMatch(/conciliado/)
  })

  it("deshacer devuelve el movimiento a pendiente y libera lo del sistema", async () => {
    expect((await request(app).delete(`/banks/transactions/${rows.get("51604453")}/match`).set(admin.auth)).status).toBe(200)
    const r = await reconcile()
    expect(r.items.find((t) => t.reference === "51604453")!.suggestion).toMatchObject({ type: "SALE_PAYMENT" })
    expect(await prisma.bankMatch.count({ where: { bankTransactionId: rows.get("51604453")! } })).toBe(0)
  })

  it("pagina sin repetir parejas y limita el rango a 3 meses", async () => {
    const page = (n: number) => request(app).get(`/banks/accounts/${accountId}/reconcile?from=${local(-12)}&to=${local(1)}&page=${n}&pageSize=2`).set(admin.auth)
    const [a, b] = [(await page(1)).body, (await page(2)).body]
    expect(a).toMatchObject({ total: 4, pageCount: 2, page: 1 }) // 2 ya conciliados arriba
    expect(a.items).toHaveLength(2)
    const ids = [...a.items, ...b.items].map((t: Row) => t.id)
    expect(new Set(ids).size).toBe(4)
    expect((await request(app).get(`/banks/accounts/${accountId}/reconcile?from=2026-01-01&to=2026-06-01`).set(admin.auth)).body.error).toMatch(/3 meses/)
  })

  it("permisos y aislamiento", async () => {
    expect((await request(app).get(`/banks/accounts/${accountId}/reconcile?from=${local()}&to=${local()}`).set(cashier.auth)).status).toBe(403)
    const other = await createUser("ADMIN")
    expect((await request(app).get(`/banks/accounts/${accountId}/reconcile?from=${local()}&to=${local()}`).set(other.auth)).status).toBe(404)
    expect((await match("5", [{ type: "CASH_DEPOSIT", id: "x" }], other)).status).toBe(404)
  })
})

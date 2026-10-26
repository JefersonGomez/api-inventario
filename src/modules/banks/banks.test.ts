// Bloque 10 (punto 53A): cuentas bancarias, importar el estado del banco, clasificar y depósitos de efectivo
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

// filas como las arma el navegador desde el CSV del Banco Nacional (datos inventados)
const ROWS = [
  { date: "2026-10-01", reference: "51604453", description: "TRANSFERENCIA SINPE/CLIENTE UNO", amount: 9500 },
  { date: "2026-10-02", reference: "267857", description: "COMISION MANTENIMIENTO", amount: -675 },
  { date: "2026-10-03", reference: "4", description: "DEPOSITO/VENTAS", amount: 200000 },
]

describe("Bancos", () => {
  let admin: User, accountant: User, employee: User
  let mainId: string, branchId: string, bnId: string

  const newAccount = (body: object, who: User = admin) =>
    request(app).post("/banks/accounts").set(who.auth).send({ name: "BN colones", bankName: "Banco Nacional", currency: "CRC", ...body })
  const importRows = (id: string, rows = ROWS, who: User = admin) =>
    request(app).post(`/banks/accounts/${id}/import`).set(who.auth).send({ fileName: "ConsultaSaldos.csv", rows })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    accountant = await createUser("ACCOUNTANT", admin.companyId)
    employee = await createUser("EMPLOYE", admin.companyId)
    mainId = await mainLocationId(admin.companyId)
    branchId = (await prisma.location.create({ data: { companyId: admin.companyId, name: "Sucursal norte", type: "BRANCH", code: "002" } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cada cuenta dice de dónde recibe el SINPE y la tarjeta (empresa y sucursales)", async () => {
    const bn = await newAccount({ number: "cr07 0102 0000 9691 2094 80", general: true, locationIds: [mainId, branchId] })
    expect(bn.status).toBe(201)
    bnId = bn.body.id
    expect(bn.body.number).toBe("CR07010200009691209480")

    // la cuenta en dólares se queda con la sucursal norte: la BN la pierde
    const bac = await newAccount({ name: "BAC dólares", bankName: "BAC", currency: "USD", locationIds: [branchId] })
    const accounts = (await request(app).get("/banks/accounts").set(accountant.auth)).body as { id: string; general: boolean; locations: { id: string }[] }[]
    const byId = new Map(accounts.map((a) => [a.id, a]))
    expect(byId.get(bnId)).toMatchObject({ general: true, locations: [{ id: mainId }] })
    expect(byId.get(bac.body.id)).toMatchObject({ general: false, locations: [{ id: branchId }] })

    // desactivarla le quita lo que recibía
    await request(app).put(`/banks/accounts/${bac.body.id}`).set(admin.auth).send({ name: "BAC dólares", bankName: "BAC", currency: "USD", isActive: false, locationIds: [branchId] })
    expect((await prisma.location.findUniqueOrThrow({ where: { id: branchId } })).bankAccountId).toBeNull()
  })

  it("importa el estado sin duplicar lo ya importado", async () => {
    const first = await importRows(bnId)
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ rows: 3, inserted: 3, duplicates: 0 })

    // el mes siguiente trae los mismos movimientos más uno nuevo
    const second = await importRows(bnId, [...ROWS, { date: "2026-10-04", reference: "99302937", description: "SIMPE 63525454/PROVEEDOR", amount: -29000 }])
    expect(second.body).toMatchObject({ rows: 4, inserted: 1, duplicates: 3 })

    const list = await request(app).get(`/banks/accounts/${bnId}/transactions`).set(admin.auth)
    expect(list.body.total).toBe(4)
    expect(list.body.totals).toEqual({ credits: 209500, debits: 29675 })
    expect(list.body.items[0]).toMatchObject({ reference: "99302937" }) // lo más nuevo primero

    expect((await importRows(bnId, [{ ...ROWS[0]!, amount: 0 }])).status).toBe(400)
    // con movimientos, la cuenta ya no cambia de moneda
    expect((await request(app).put(`/banks/accounts/${bnId}`).set(admin.auth).send({ name: "BN", bankName: "BN", currency: "USD", general: true })).body.error).toMatch(/moneda/)
  })

  it("clasifica lo que no tiene pareja y se puede deshacer", async () => {
    const fee = await prisma.bankTransaction.findFirstOrThrow({ where: { reference: "267857" } })
    const res = await request(app).patch(`/banks/transactions/${fee.id}`).set(accountant.auth).send({ category: "BANK_FEE", note: "Mantenimiento de cuenta" })
    expect(res.body).toMatchObject({ category: "BANK_FEE", reviewedById: accountant.user.id })

    const pending = await request(app).get(`/banks/accounts/${bnId}/transactions?status=pending`).set(admin.auth)
    expect(pending.body.total).toBe(3)
    const reviewed = await request(app).get(`/banks/accounts/${bnId}/transactions?status=reviewed`).set(admin.auth)
    expect(reviewed.body.items.map((t: { id: string }) => t.id)).toEqual([fee.id])

    await request(app).patch(`/banks/transactions/${fee.id}`).set(admin.auth).send({ category: null })
    expect((await request(app).get(`/banks/accounts/${bnId}/transactions?status=pending&q=comision`).set(admin.auth)).body.total).toBe(1)
    expect((await request(app).patch(`/banks/transactions/${fee.id}`).set(admin.auth).send({ category: "NADA" })).status).toBe(400)
  })

  it("depósito del efectivo de la caja: lo registra quien hace arqueos", async () => {
    const manager = await createUser("MANAGER", admin.companyId)
    const res = await request(app).post("/banks/deposits").set(manager.auth)
      .send({ bankAccountId: bnId, locationId: mainId, amount: 200000, depositedAt: "2026-10-03", reference: "DEP-55" })
    expect(res.status).toBe(201)
    expect((await request(app).post("/banks/deposits").set(manager.auth).send({ bankAccountId: bnId, amount: 1, depositedAt: "2026-10-03" })).status).toBe(400)
    const list = await request(app).get(`/banks/deposits?bankAccountId=${bnId}`).set(accountant.auth)
    expect(list.body.items[0]).toMatchObject({ reference: "DEP-55", location: { id: mainId }, user: { id: manager.user.id } })
  })

  it("los pagos guardan de qué cuenta salieron o a cuál entraron", async () => {
    const supplierId = (await request(app).post("/suppliers").set(admin.auth).send({ name: "Proveedor" })).body.id
    await request(app).post("/payables/invoices").set(admin.auth).send({ supplierId, number: "F1", issueDate: "2026-10-01", subtotal: 5000, tax: 0 })
    const transfer = await request(app).post("/payables/payments").set(admin.auth).send({ supplierId, amount: 1000, method: "TRANSFER", reference: "T1", bankAccountId: bnId })
    expect(transfer.status).toBe(201)
    expect(transfer.body.bankAccountId).toBe(bnId)
    // en efectivo no sale de ninguna cuenta
    const cash = await request(app).post("/payables/payments").set(admin.auth).send({ supplierId, amount: 1000, method: "CASH", bankAccountId: bnId })
    expect(cash.body.bankAccountId).toBeNull()
    // cuenta inactiva o ajena
    const inactive = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: admin.companyId, isActive: false } })
    expect((await request(app).post("/payables/payments").set(admin.auth).send({ supplierId, amount: 1, method: "SINPE", reference: "S1", bankAccountId: inactive.id })).status).toBe(404)
  })

  it("permisos y aislamiento entre empresas", async () => {
    expect((await request(app).get("/banks/accounts").set(employee.auth)).status).toBe(403)
    expect((await request(app).post("/banks/deposits").set(employee.auth).send({ bankAccountId: bnId, amount: 1, depositedAt: "2026-10-03", reference: "X" })).status).toBe(403)
    const other = await createUser("ADMIN")
    expect((await importRows(bnId, ROWS, other)).status).toBe(404)
    expect((await request(app).get("/banks/accounts").set(other.auth)).body).toEqual([])
    const tx = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId: bnId } })
    expect((await request(app).patch(`/banks/transactions/${tx.id}`).set(other.auth).send({ category: "OTHER" })).status).toBe(404)
  })
})

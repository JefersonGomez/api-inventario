// Bloque 6B: guía de primeros pasos calculada con los datos reales de la empresa
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"

describe("Primeros pasos", () => {
  let admin: Awaited<ReturnType<typeof createUser>>
  const status = async () => (await request(app).get("/company/onboarding").set(admin.auth)).body
  const done = async () => Object.fromEntries((await status()).steps.map((s: { key: string; done: boolean }) => [s.key, s.done]))

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("una empresa nueva arranca con todo pendiente", async () => {
    const s = await status()
    expect(s).toMatchObject({ completed: 0, total: 7, dismissed: false })
  })

  it("cada paso se marca solo al hacerlo", async () => {
    await request(app).put("/company").set(admin.auth).send({
      legalName: "Mi Empresa S.A.", idType: "JURIDICA", idNumber: "3101123456", economicActivity: "523101", province: "1",
    })
    await prisma.location.update({ where: { id: await mainLocationId(admin.companyId) }, data: { address: "San José, 100 m norte del parque" } })
    const category = await prisma.category.create({ data: { companyId: admin.companyId, name: "General" } })
    await request(app).post("/products").set(admin.auth).send({ sku: "A", name: "A", price: 100, stock: 0, minStock: 0, categoryId: category.id })
    expect(await done()).toMatchObject({ fiscal: true, branch: true, categories: true, products: true, taxes: false, team: false, cashCodes: false })
    expect((await status()).steps.find((s: { key: string }) => s.key === "taxes").meta).toEqual({ withoutCabys: 1, pending: 0 })

    await prisma.product.updateMany({ where: { companyId: admin.companyId }, data: { cabys: "1234567890123" } })
    await request(app).post("/invitations").set(admin.auth).send({ email: "cajero@test.com", role: "CASHIER" })
    await request(app).put("/profile/me/pin").set(admin.auth).send({ pin: "4821", password: "123456" })
    expect(await status()).toMatchObject({ completed: 7 })
  })

  it("el administrador la oculta (y la puede volver a mostrar); los demás no la ven", async () => {
    expect((await request(app).put("/company/onboarding").set(admin.auth).send({})).body.dismissed).toBe(true)
    expect((await request(app).put("/company/onboarding").set(admin.auth).send({ dismissed: false })).body.dismissed).toBe(false)
    const employee = await createUser("EMPLOYE", admin.companyId)
    expect((await request(app).get("/company/onboarding").set(employee.auth)).status).toBe(403)
  })
})

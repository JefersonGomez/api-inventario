// Moneda por empresa: se elige en Configuración y es independiente entre empresas
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { formatMoney } from "../../shared/money.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

describe("Moneda de la empresa", () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("las empresas nacen en colones", async () => {
    const admin = await createUser("ADMIN")
    const company = await request(app).get("/company").set(admin.auth)
    expect(company.body.currency).toBe("CRC")
  })

  it("el admin cambia la moneda (sola o junto al nombre) y queda en auditoría", async () => {
    const admin = await createUser("ADMIN")
    const onlyCurrency = await request(app).put("/company").set(admin.auth).send({ currency: "USD" })
    expect(onlyCurrency.status).toBe(200)
    expect(onlyCurrency.body.currency).toBe("USD")

    const both = await request(app).put("/company").set(admin.auth).send({ name: "Nueva S.A.", currency: "CRC" })
    expect(both.body).toMatchObject({ name: "Nueva S.A.", currency: "CRC" })

    const audit = await prisma.auditLog.findMany({ where: { entityType: "Company", companyId: admin.companyId } })
    expect(audit).toHaveLength(2)
  })

  it("rechaza monedas no soportadas y body vacío; un empleado no puede cambiarla", async () => {
    const admin = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", admin.companyId)
    expect((await request(app).put("/company").set(admin.auth).send({ currency: "EUR" })).status).toBe(400)
    expect((await request(app).put("/company").set(admin.auth).send({})).status).toBe(400)
    expect((await request(app).put("/company").set(emp.auth).send({ currency: "USD" })).status).toBe(403)
    // pero sí la puede leer, para mostrar los montos con su formato
    expect((await request(app).get("/company").set(emp.auth)).body.currency).toBe("CRC")
  })

  it("cada empresa tiene la suya", async () => {
    const a = await createUser("ADMIN")
    const b = await createUser("ADMIN")
    await request(app).put("/company").set(a.auth).send({ currency: "USD" })
    expect((await request(app).get("/company").set(a.auth)).body.currency).toBe("USD")
    expect((await request(app).get("/company").set(b.auth)).body.currency).toBe("CRC")
  })

  it("una empresa nueva puede crearse directamente en dólares", async () => {
    const admin = await createUser("ADMIN")
    await prisma.user.update({ where: { id: admin.user.id }, data: { plan: "PRO" } })
    const created = await request(app).post("/companies").set(admin.auth).send({ name: "Sucursal USA", currency: "USD" })
    expect(created.status).toBe(201)
    const row = await prisma.company.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(row.currency).toBe("USD")
  })

  it("formatMoney da el símbolo correcto para el correo", () => {
    expect(formatMoney(1500, "CRC")).toContain("₡")
    expect(formatMoney(1500, "USD")).toMatch(/US\$|\$/)
    expect(formatMoney(1234.5, "CRC")).toContain("1")
  })
})

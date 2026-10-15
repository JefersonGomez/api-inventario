// Bloque 1B: clientes, identificación de proveedores y datos fiscales de la empresa
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Clientes y datos fiscales", () => {
  let admin: User
  let employee: User

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    employee = await createUser("EMPLOYE", admin.companyId)
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("el empleado registra un cliente; la cédula se guarda sin guiones y no se repite", async () => {
    const res = await request(app).post("/customers").set(employee.auth)
      .send({ name: "Ferretería La Unión", idType: "JURIDICA", idNumber: "3-101-123456", email: "compras@union.test", creditLimit: 500000, creditDays: 30 })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ idType: "JURIDICA", idNumber: "3101123456", creditLimit: 500000, creditDays: 30 })

    const dup = await request(app).post("/customers").set(admin.auth).send({ name: "Otra", idType: "JURIDICA", idNumber: "3101123456" })
    expect(dup.status).toBe(400)
    expect(dup.body.error).toMatch(/Ferretería La Unión/)
  })

  it("valida el número según el tipo y que vengan juntos", async () => {
    const bad = (body: object) => request(app).post("/customers").set(admin.auth).send({ name: "X", ...body })
    expect((await bad({ idType: "FISICA", idNumber: "12345" })).status).toBe(400) // física = 9 dígitos
    expect((await bad({ idType: "DIMEX", idNumber: "1234567890" })).status).toBe(400) // DIMEX = 11 o 12
    expect((await bad({ idNumber: "112340567" })).status).toBe(400) // número sin tipo
    expect((await bad({ idType: "FISICA", idNumber: "1-1234-0567" })).status).toBe(201)
    expect((await bad({ name: "Sin cédula" })).status).toBe(201) // consumidor final: sin identificación
  })

  it("sin límite de crédito no queda plazo; solo el ADMIN borra y el borrado libera la cédula", async () => {
    const created = await request(app).post("/customers").set(admin.auth).send({ name: "Contado", idType: "FISICA", idNumber: "205550111", creditDays: 15 })
    expect(created.body).toMatchObject({ creditLimit: null, creditDays: null })

    expect((await request(app).delete(`/customers/${created.body.id}`).set(employee.auth)).status).toBe(403)
    expect((await request(app).delete(`/customers/${created.body.id}`).set(admin.auth)).status).toBe(204)
    const list = await request(app).get("/customers").set(employee.auth)
    expect((list.body as { id: string }[]).some((c) => c.id === created.body.id)).toBe(false)
    // la misma cédula se puede volver a registrar
    expect((await request(app).post("/customers").set(admin.auth).send({ name: "Contado 2", idType: "FISICA", idNumber: "205550111" })).status).toBe(201)
  })

  it("los clientes no se ven entre empresas", async () => {
    const other = await createUser("ADMIN")
    await request(app).post("/customers").set(other.auth).send({ name: "Cliente ajeno" })
    const mine = await request(app).get("/customers").set(admin.auth)
    expect((mine.body as { name: string }[]).map((c) => c.name)).not.toContain("Cliente ajeno")
  })

  it("proveedor con identificación", async () => {
    const res = await request(app).post("/suppliers").set(admin.auth).send({ name: "Distribuidora", idType: "JURIDICA", idNumber: "3101999888" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ idType: "JURIDICA", idNumber: "3101999888" })
    expect((await request(app).post("/suppliers").set(admin.auth).send({ name: "Mal", idType: "JURIDICA", idNumber: "12" })).status).toBe(400)
  })

  it("datos fiscales de la empresa: se guardan, se validan y \"\" los borra", async () => {
    const res = await request(app).put("/company").set(admin.auth).send({
      legalName: "Jeferson Bustamante Gómez", idType: "FISICA", idNumber: "112340567", economicActivity: "620100",
      invoiceEmail: "facturas@stockly.test", province: "1", canton: "01", district: "08", addressDetail: "100 m norte del parque",
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ legalName: "Jeferson Bustamante Gómez", idNumber: "112340567", province: "1", district: "08" })

    expect((await request(app).put("/company").set(admin.auth).send({ province: "8" })).status).toBe(400)
    expect((await request(app).put("/company").set(admin.auth).send({ canton: "1" })).status).toBe(400)
    expect((await request(app).put("/company").set(admin.auth).send({})).status).toBe(400)
    expect((await request(app).put("/company").set(employee.auth).send({ legalName: "X" })).status).toBe(403)

    const cleared = await request(app).put("/company").set(admin.auth).send({ addressDetail: "", idType: null, idNumber: "" })
    expect(cleared.body).toMatchObject({ addressDetail: null, idType: null, idNumber: null, legalName: "Jeferson Bustamante Gómez" })
  })
})

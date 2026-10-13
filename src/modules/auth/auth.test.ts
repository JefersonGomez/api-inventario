import request from "supertest"
import app from "../../app.ts"
import { resetDb } from "../../test/helpers.ts"
import { prisma } from "../../config/database.ts"

describe("POST /auth/register", () => {
  beforeAll(async () => {
    await resetDb()
  })

  afterEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("debería registrar un usuario nuevo correctamente", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Test",
        email: "test@example.com",
        password: "Clave-segura-1"
      })

    expect(response.status).toBe(201)
    expect(response.body.email).toBe("test@example.com")
    expect(response.body.passwordHash).toBeUndefined()
    // registrarse crea su propia empresa y queda como ADMIN de ella
    expect(response.body.role).toBe("ADMIN")
    expect(response.body.companyId).toBeTruthy()
  })

  it("debería rechazar un registro con email ya existente", async () => {
    // Primero creamos el usuario
    await request(app)
      .post("/auth/register")
      .send({
        name: "Test",
        email: "test@example.com",
        password: "Clave-segura-1"
      })

    // Intentamos crearlo de nuevo con el mismo email
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Test 2",
        email: "test@example.com",
        password: "Clave-segura-1"
      })

    expect(response.status).toBe(400)
  })
})
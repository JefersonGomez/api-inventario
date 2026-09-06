import request from "supertest"
import app from "../../app.ts"
import { prisma } from "../../config/database.ts"

describe("POST /auth/register", () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: "test@example.com" } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("debería registrar un usuario nuevo correctamente", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Test",
        email: "test@example.com",
        password: "123456"
      })

    expect(response.status).toBe(201)
    expect(response.body.email).toBe("test@example.com")
    expect(response.body.passwordHash).toBeUndefined()
  })

  it("debería rechazar un registro con email ya existente", async () => {
    // Primero creamos el usuario
    await request(app)
      .post("/auth/register")
      .send({
        name: "Test",
        email: "test@example.com",
        password: "123456"
      })

    // Intentamos crearlo de nuevo con el mismo email
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Test 2",
        email: "test@example.com",
        password: "123456"
      })

    expect(response.status).toBe(400)
  })
})
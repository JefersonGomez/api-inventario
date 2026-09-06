import request from "supertest"
import app from "../../app.ts"
import { prisma } from "../../config/database.ts"

describe("POST /auth/login", () => {
  const testEmail = "login-test@example.com"
  const testPassword = "123456"

  beforeAll(async () => {
    // Nos apoyamos en el endpoint real de registro para crear el usuario de prueba
    await request(app).post("/auth/register").send({
      name: "Login Test",
      email: testEmail,
      password: testPassword
    })
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.$disconnect()
  })

  it("debería devolver un token con credenciales correctas", async () => {
    const response = await request(app).post("/auth/login").send({
      email: testEmail,
      password: testPassword
    })

    expect(response.status).toBe(200)
    expect(typeof response.body.token).toBe("string")
    expect(response.body.token.length).toBeGreaterThan(0)
  })

  it("debería rechazar credenciales con contraseña incorrecta", async () => {
  const response = await request(app).post("/auth/login").send({
    email: testEmail,
    password: "clave-incorrecta"
  })
  expect(response.status).toBe(401)  // antes 400
})

it("debería rechazar login con email que no existe", async () => {
  const response = await request(app).post("/auth/login").send({
    email: "no-existe@example.com",
    password: "123456"
  })
  expect(response.status).toBe(401)  // antes 400
})
})
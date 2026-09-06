import request from "supertest"
import app from "../app.ts"
import { prisma } from "../config/database.ts"

describe("Middleware Authenticated", () => {
  const testEmail = "middleware-test@example.com"
  const testPassword = "123456"
  let token: string

  beforeAll(async () => {
    await request(app).post("/auth/register").send({
      name: "Middleware Test",
      email: testEmail,
      password: testPassword
    })

    const loginResponse = await request(app).post("/auth/login").send({
      email: testEmail,
      password: testPassword
    })

    token = loginResponse.body.token
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.$disconnect()
  })

  it("debería rechazar la petición sin header Authorization", async () => {
    const response = await request(app).get("/categories/")

    expect(response.status).toBe(401)
  })

  it("debería rechazar un token mal formado", async () => {
    const response = await request(app)
      .get("/categories/")
      .set("Authorization", "Bearer token-invalido")

    expect(response.status).toBe(401)
  })

  it("debería permitir el acceso con un token válido", async () => {
    const response = await request(app)
      .get("/categories/")
      .set("Authorization", `Bearer ${token}`)

    expect(response.status).toBe(200)
  })
})
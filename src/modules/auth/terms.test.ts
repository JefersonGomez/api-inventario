// Aceptación de términos y política de privacidad: obligatoria al crear una cuenta, con constancia
import request from "supertest"
import bcrypt from "bcrypt"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { TERMS_VERSION } from "../../config/legal.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

describe("Términos y política de privacidad", () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  const register = (extra: object) =>
    request(app).post("/auth/register").send({ name: "Ana", email: "ana@test.com", password: "Clave-segura-1", ...extra })

  it("no se crea la cuenta sin aceptar (ni con false ni omitido)", async () => {
    for (const extra of [{}, { acceptTerms: false }, { acceptTerms: "true" }]) {
      const res = await register(extra)
      expect(res.status).toBe(400)
    }
    expect(await prisma.user.count()).toBe(0)
  })

  it("al aceptar queda la constancia: fecha y versión", async () => {
    const before = Date.now()
    const res = await register({ acceptTerms: true })
    expect(res.status).toBe(201)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "ana@test.com" } })
    expect(user.termsVersion).toBe(TERMS_VERSION)
    expect(user.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it("una cuenta nueva por invitación también debe aceptar; una existente no", async () => {
    const admin = await createUser("ADMIN")
    const invite = async (email: string) => {
      const { body } = await request(app).post("/invitations").set(admin.auth).send({ email })
      return `/invitations/token/${body.link.split("/invite/")[1]}/accept`
    }

    const newUrl = await invite("nuevo@test.com")
    const refused = await request(app).post(newUrl).send({ name: "Nuevo", password: "Clave-segura-1" })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain("aceptar")
    expect(await prisma.user.count({ where: { email: "nuevo@test.com" } })).toBe(0)

    const accepted = await request(app).post(newUrl).send({ name: "Nuevo", password: "Clave-segura-1", acceptTerms: true })
    expect(accepted.status).toBe(200)
    const created = await prisma.user.findUniqueOrThrow({ where: { email: "nuevo@test.com" } })
    expect(created.termsVersion).toBe(TERMS_VERSION)

    // cuenta existente: entra con su contraseña, sin volver a aceptar
    const other = await createUser("ADMIN")
    await prisma.user.update({ where: { id: other.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
    const existingUrl = await invite(other.user.email)
    expect((await request(app).post(existingUrl).send({ password: "Clave-segura-1" })).status).toBe(200)
  })

  it("las cuentas anteriores a los documentos no se bloquean: siguen entrando", async () => {
    const u = await createUser("ADMIN")
    await prisma.user.update({ where: { id: u.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.user.id } })).termsAcceptedAt).toBeNull()
    const login = await request(app).post("/auth/login").send({ email: u.user.email, password: "Clave-segura-1" })
    expect(login.status).toBe(200)
  })
})

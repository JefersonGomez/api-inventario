// Seguridad básica: límite de intentos, política de contraseñas, subida de imágenes,
// manejo de errores, cabeceras y configuración obligatoria.
import fs from "node:fs"
import path from "node:path"
import request from "supertest"
import bcrypt from "bcrypt"
import express from "express"
import app from "../app.ts"
import { prismaRoot as prisma } from "../config/database.ts"
import { assertEnv, jwtSecret } from "../config/env.ts"
import { sanitizeErrors } from "../middlewares/error.middleware.ts"
import { resetDb, createUser } from "../test/helpers.ts"

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const uploaded: string[] = []
const track = (url?: string) => url && uploaded.push(path.join(process.cwd(), url))

describe("Seguridad", () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    uploaded.forEach((f) => fs.rmSync(f, { force: true }))
    await resetDb()
    await prisma.$disconnect()
  })

  describe("límite de intentos de login", () => {
    afterEach(() => {
      process.env.RATE_LIMIT_OFF = "1"
    })

    it("bloquea tras 10 fallos de la misma cuenta, sin afectar a otras", async () => {
      process.env.RATE_LIMIT_OFF = "0"
      const victim = await createUser("ADMIN")
      const other = await createUser("ADMIN")
      await prisma.user.updateMany({ data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })

      for (let i = 0; i < 10; i++) {
        const r = await request(app).post("/auth/login").send({ email: victim.user.email, password: "incorrecta" })
        expect(r.status).toBe(401)
      }
      const blocked = await request(app).post("/auth/login").send({ email: victim.user.email, password: "Clave-segura-1" })
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toContain("Demasiados intentos")

      const fine = await request(app).post("/auth/login").send({ email: other.user.email, password: "Clave-segura-1" })
      expect(fine.status).toBe(200)
    })

    it("los inicios de sesión correctos no cuentan", async () => {
      process.env.RATE_LIMIT_OFF = "0"
      const u = await createUser("ADMIN")
      await prisma.user.update({ where: { id: u.user.id }, data: { passwordHash: await bcrypt.hash("Clave-segura-1", 4) } })
      for (let i = 0; i < 15; i++) {
        const r = await request(app).post("/auth/login").send({ email: u.user.email, password: "Clave-segura-1" })
        expect(r.status).toBe(200)
      }
    })
  })

  describe("contraseñas", () => {
    const register = (password: string, email = "nuevo@test.com") =>
      request(app).post("/auth/register").send({ acceptTerms: true, name: "Nuevo", email, password })

    it("exige 8 caracteres y rechaza las más comunes", async () => {
      expect((await register("1234567")).status).toBe(400)
      expect((await register("Password123")).status).toBe(400) // común (sin importar mayúsculas)
      expect((await register("x".repeat(73))).status).toBe(400)
      expect((await register("Clave-segura-1")).status).toBe(201)
    })

    it("una cuenta con contraseña antigua de 6 caracteres sigue pudiendo entrar", async () => {
      const u = await createUser("EMPLOYE")
      await prisma.user.update({ where: { id: u.user.id }, data: { passwordHash: await bcrypt.hash("abc123", 4) } })
      const login = await request(app).post("/auth/login").send({ email: u.user.email, password: "abc123" })
      expect(login.status).toBe(200)
    })

    it("al cambiarla desde el perfil aplica la política nueva", async () => {
      const u = await createUser("EMPLOYE")
      await prisma.user.update({ where: { id: u.user.id }, data: { passwordHash: await bcrypt.hash("abc123", 4) } })
      const change = (newPassword: string) =>
        request(app).put("/profile/me/password").set(u.auth).send({ currentPassword: "abc123", newPassword })
      expect((await change("corta")).status).toBe(400)
      expect((await change("12345678")).status).toBe(400)
      expect((await change("Otra-clave-9")).status).toBe(200)
    })

    it("una cuenta nueva por invitación también cumple la política", async () => {
      const admin = await createUser("ADMIN")
      const { body } = await request(app).post("/invitations").set(admin.auth).send({ email: "inv@test.com" })
      const token = body.link.split("/invite/")[1]
      const weak = await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, name: "Inv", password: "password" })
      expect(weak.status).toBe(400)
      const ok = await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, name: "Inv", password: "Clave-segura-1" })
      expect(ok.status).toBe(200)
    })
  })

  describe("foto de perfil", () => {
    const upload = (u: Awaited<ReturnType<typeof createUser>>, data: Buffer, filename: string, contentType: string) =>
      request(app).post("/profile/me/avatar").set(u.auth).attach("avatar", data, { filename, contentType })

    it("acepta una imagen real y la guarda con extensión segura, ignorando el nombre del cliente", async () => {
      const u = await createUser("EMPLOYE")
      const res = await upload(u, PNG, "evil.html", "image/png")
      track(res.body.avatarUrl)
      expect(res.status).toBe(200)
      expect(res.body.avatarUrl).toMatch(/\.png$/)
      expect(res.body.avatarUrl).not.toContain("html")
    })

    it("rechaza un archivo que dice ser imagen pero no lo es, y no lo deja en disco", async () => {
      const u = await createUser("EMPLOYE")
      const before = fs.readdirSync("uploads/avatars").length
      const res = await upload(u, Buffer.from("<script>alert(1)</script>"), "foto.png", "image/png")
      expect(res.status).toBe(400)
      expect(res.body.error).toContain("no es una imagen")
      expect(fs.readdirSync("uploads/avatars").length).toBe(before)
    })

    it("rechaza otros tipos y archivos demasiado grandes", async () => {
      const u = await createUser("EMPLOYE")
      expect((await upload(u, Buffer.from("MZ"), "a.exe", "application/octet-stream")).status).toBe(400)
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])
      const res = await upload(u, big, "grande.png", "image/png")
      expect(res.status).toBe(400)
      expect(res.body.error).toContain("grande")
    })
  })

  describe("errores y cabeceras", () => {
    it("un JSON mal formado da 400 limpio, y una ruta inexistente 404 en JSON", async () => {
      const bad = await request(app).post("/auth/login").set("Content-Type", "application/json").send("{no es json")
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBeTruthy()
      expect(JSON.stringify(bad.body)).not.toMatch(/Unexpected|position|at /)

      const missing = await request(app).get("/no-existe")
      expect(missing.status).toBe(404)
      expect(missing.body.error).toBe("Ruta no encontrada")
    })

    it("un mensaje con detalles de Prisma/Postgres no llega al cliente", async () => {
      const mini = express()
      mini.use(sanitizeErrors)
      mini.get("/leak", (_req, res) => {
        res.status(400).json({ error: "Invalid `prisma.user.create()` invocation: Unique constraint failed on the fields: (`email`)" })
      })
      mini.get("/normal", (_req, res) => {
        res.status(400).json({ error: "El usuario ya existe" })
      })
      const leak = await request(mini).get("/leak")
      expect(leak.body.error).toBe("Ocurrió un error interno. Intenta de nuevo.")
      expect((await request(mini).get("/normal")).body.error).toBe("El usuario ya existe")
    })

    it("responde con cabeceras de seguridad y sin delatar el framework", async () => {
      const res = await request(app).get("/health")
      expect(res.headers["x-content-type-options"]).toBe("nosniff")
      expect(res.headers["x-powered-by"]).toBeUndefined()
      expect(res.headers["x-frame-options"]).toBeTruthy()
    })

    it("rechaza cuerpos JSON enormes", async () => {
      const res = await request(app).post("/auth/login").send({ email: "a@b.com", password: "x".repeat(200_000) })
      expect(res.status).toBe(413)
    })
  })

  describe("configuración obligatoria", () => {
    const saved = { ...process.env }
    afterEach(() => {
      process.env = { ...saved }
    })

    it("sin JWT_SECRET_KEY no hay clave por defecto: falla", () => {
      delete process.env.JWT_SECRET_KEY
      expect(() => jwtSecret()).toThrow("JWT_SECRET_KEY")
    })

    it("en producción exige una clave de al menos 32 caracteres", () => {
      process.env.DATABASE_URL = "postgresql://x"
      process.env.NODE_ENV = "production"
      process.env.JWT_SECRET_KEY = "corta"
      expect(() => assertEnv()).toThrow("32")
      process.env.JWT_SECRET_KEY = "a".repeat(40)
      expect(() => assertEnv()).not.toThrow()
    })
  })
})

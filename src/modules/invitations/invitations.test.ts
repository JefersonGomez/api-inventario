// Invitaciones: crear link, aceptar con cuenta nueva o existente, vencimiento, anulación y límite del plan
import request from "supertest"
import bcrypt from "bcrypt"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

const tokenOf = (link: string) => link.split("/invite/")[1]!

describe("Invitaciones", () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cuenta nueva: el link muestra la empresa y al aceptar entra ya dentro de ella", async () => {
    const admin = await createUser("ADMIN")
    const created = await request(app).post("/invitations").set(admin.auth).send({ email: "Nuevo@Test.com", role: "EMPLOYE" })
    expect(created.status).toBe(201)
    expect(created.body.link).toContain("/invite/")
    const token = tokenOf(created.body.link)

    const info = await request(app).get(`/invitations/token/${token}`)
    expect(info.body).toMatchObject({ status: "valid", email: "nuevo@test.com", role: "EMPLOYE", userExists: false })

    const accepted = await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, name: "Nuevo", password: "Clave-segura-1" })
    expect(accepted.status).toBe(200)
    expect(accepted.body.company.id).toBe(admin.companyId)
    expect(accepted.body.user.role).toBe("EMPLOYE")

    // la sesión devuelta sirve y ve los datos de esa empresa
    expect((await request(app).get("/products").set({ Authorization: `Bearer ${accepted.body.token}` })).status).toBe(200)
    // el link ya no se puede reutilizar
    expect((await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, name: "Otro", password: "Clave-segura-1" })).status).toBe(400)
    // quien invitó recibe el aviso
    expect(await prisma.notification.count({ where: { userId: admin.user.id, type: "memberJoined" } })).toBe(1)
  })

  it("cuenta existente: entra con su contraseña y suma la empresa a las suyas", async () => {
    const admin = await createUser("ADMIN")
    const other = await createUser("ADMIN") // ya tiene su propia empresa
    await prisma.user.update({ where: { id: other.user.id }, data: { passwordHash: await bcrypt.hash("secreta1", 4) } })

    const { body } = await request(app).post("/invitations").set(admin.auth).send({ email: other.user.email, role: "ADMIN" })
    const token = tokenOf(body.link)
    expect((await request(app).get(`/invitations/token/${token}`)).body.userExists).toBe(true)

    expect((await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, password: "incorrecta" })).status).toBe(400)
    const ok = await request(app).post(`/invitations/token/${token}/accept`).send({ acceptTerms: true, password: "secreta1" })
    expect(ok.status).toBe(200)
    expect(ok.body.companies).toHaveLength(2)
    expect(ok.body.company.id).toBe(admin.companyId)
  })

  it("vencida o anulada no se puede aceptar; renovar invalida el link anterior", async () => {
    const admin = await createUser("ADMIN")
    const first = await request(app).post("/invitations").set(admin.auth).send({ email: "a@test.com" })
    const second = await request(app).post("/invitations").set(admin.auth).send({ email: "a@test.com" })
    expect((await request(app).get(`/invitations/token/${tokenOf(first.body.link)}`)).body.status).toBe("revoked")

    // anular
    expect((await request(app).delete(`/invitations/${second.body.invitation.id}`).set(admin.auth)).status).toBe(204)
    expect((await request(app).post(`/invitations/token/${tokenOf(second.body.link)}/accept`).send({ acceptTerms: true, name: "A", password: "Clave-segura-1" })).status).toBe(400)

    // vencer
    const third = await request(app).post("/invitations").set(admin.auth).send({ email: "b@test.com" })
    await prisma.invitation.update({ where: { id: third.body.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const expired = await request(app).post(`/invitations/token/${tokenOf(third.body.link)}/accept`).send({ acceptTerms: true, name: "B", password: "Clave-segura-1" })
    expect(expired.status).toBe(400)
    expect(expired.body.error).toContain("venció")
  })

  it("el plan limita usuarios + invitaciones pendientes (BASIC = 3)", async () => {
    const admin = await createUser("ADMIN") // 1
    await createUser("EMPLOYE", admin.companyId) // 2
    expect((await request(app).post("/invitations").set(admin.auth).send({ email: "c@test.com" })).status).toBe(201) // 3 (pendiente)
    const over = await request(app).post("/invitations").set(admin.auth).send({ email: "d@test.com" })
    expect(over.status).toBe(400)
    expect(over.body.error).toContain("3 usuarios")

    const pending = await request(app).get("/invitations").set(admin.auth)
    expect(pending.body.map((i: { email: string }) => i.email)).toEqual(["c@test.com"])
  })

  it("solo el admin de la empresa invita, y no ve invitaciones de otras empresas", async () => {
    const admin = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", admin.companyId)
    expect((await request(app).post("/invitations").set(emp.auth).send({ email: "x@test.com" })).status).toBe(403)

    const other = await createUser("ADMIN")
    const { body } = await request(app).post("/invitations").set(other.auth).send({ email: "y@test.com" })
    expect((await request(app).get("/invitations").set(admin.auth)).body).toEqual([])
    expect((await request(app).delete(`/invitations/${body.invitation.id}`).set(admin.auth)).status).toBe(404)
  })

  it("no se invita a alguien que ya es miembro activo", async () => {
    const admin = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", admin.companyId)
    const res = await request(app).post("/invitations").set(admin.auth).send({ email: emp.user.email })
    expect(res.status).toBe(400)
  })
})

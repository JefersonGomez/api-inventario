// Panel del dueño de la plataforma: listar empresas, cambiar plan, suspender y reactivar
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"

describe("Panel de plataforma", () => {
  let owner: Awaited<ReturnType<typeof createUser>>

  beforeEach(async () => {
    await resetDb()
    owner = await createUser("ADMIN")
    await prisma.user.update({ where: { id: owner.user.id }, data: { isPlatformOwner: true } })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("el dueño ve todas las empresas con plan, uso y estado, pero no sus datos de inventario", async () => {
    const client = await createUser("ADMIN")
    const category = await prisma.category.create({ data: { companyId: client.companyId, name: "Secreta" } })
    await prisma.product.createMany({
      data: [1, 2, 3].map((n) => ({ companyId: client.companyId, sku: `S-${n}`, name: `Producto privado ${n}`, price: 1, stock: 0, minStock: 0, categoryId: category.id })),
    })
    await createUser("EMPLOYE", client.companyId)

    const res = await request(app).get("/platform/companies").set(owner.auth)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    const row = res.body.find((c: { id: string }) => c.id === client.companyId)
    expect(row).toMatchObject({ plan: "BASIC", users: 2, products: 3, suspendedAt: null })
    expect(row.owner.email).toBe(client.user.email)
    expect(row.limits.maxProducts).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain("Producto privado")
    expect(JSON.stringify(res.body)).not.toContain("passwordHash")
  })

  it("un administrador de empresa o un empleado no puede entrar al panel", async () => {
    const admin = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", admin.companyId)
    for (const u of [admin, emp]) {
      expect((await request(app).get("/platform/companies").set(u.auth)).status).toBe(403)
      expect((await request(app).patch(`/platform/companies/${admin.companyId}/plan`).set(u.auth).send({ plan: "BUSINESS" })).status).toBe(403)
      expect((await request(app).patch(`/platform/companies/${admin.companyId}/suspension`).set(u.auth).send({ suspended: true })).status).toBe(403)
    }
    expect((await request(app).get("/platform/companies")).status).toBe(401)
    // y nadie se puede marcar a sí mismo desde la app
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).isPlatformOwner).toBe(false)
  })

  it("cambiar el plan cambia los límites, y queda en la auditoría de esa empresa", async () => {
    const client = await createUser("ADMIN")
    const res = await request(app).patch(`/platform/companies/${client.companyId}/plan`).set(owner.auth).send({ plan: "PRO" })
    expect(res.status).toBe(204)

    const company = await request(app).get("/company").set(client.auth)
    expect(company.body.plan).toBe("PRO")
    expect(company.body.limits.maxProducts).toBe(5000)

    const audit = await prisma.auditLog.findFirst({ where: { companyId: client.companyId, entityType: "Company" } })
    expect(audit?.changes).toMatchObject({ plan: "PRO", by: "platform" })
    expect((await request(app).patch(`/platform/companies/${client.companyId}/plan`).set(owner.auth).send({ plan: "GRATIS" })).status).toBe(400)
  })

  it("una empresa suspendida solo ve el aviso; al reactivarla todo vuelve", async () => {
    const client = await createUser("ADMIN")
    const emp = await createUser("EMPLOYE", client.companyId)

    const suspend = await request(app).patch(`/platform/companies/${client.companyId}/suspension`).set(owner.auth)
      .send({ suspended: true, reason: "Pago pendiente" })
    expect(suspend.status).toBe(204)

    for (const u of [client, emp]) {
      const blocked = await request(app).get("/products").set(u.auth)
      expect(blocked.status).toBe(403)
      expect(blocked.body.code).toBe("COMPANY_SUSPENDED")
      expect(blocked.body.error).toBe("Pago pendiente")
      expect((await request(app).post("/movements").set(u.auth).send({ productId: "00000000-0000-0000-0000-000000000000", type: "IN", quantity: 1 })).status).toBe(403)
    }
    // lo mínimo para mostrar el aviso y cambiar de empresa sigue disponible
    const info = await request(app).get("/company").set(client.auth)
    expect(info.status).toBe(200)
    expect(info.body.suspendedAt).toBeTruthy()
    expect(info.body.suspensionReason).toBe("Pago pendiente")
    expect((await request(app).get("/companies").set(client.auth)).status).toBe(200)

    await request(app).patch(`/platform/companies/${client.companyId}/suspension`).set(owner.auth).send({ suspended: false })
    expect((await request(app).get("/products").set(client.auth)).status).toBe(200)
    expect((await request(app).get("/company").set(client.auth)).body.suspendedAt).toBeNull()
  })

  it("suspender una empresa no afecta a las demás ni al dueño de la plataforma", async () => {
    const a = await createUser("ADMIN")
    const b = await createUser("ADMIN")
    await request(app).patch(`/platform/companies/${a.companyId}/suspension`).set(owner.auth).send({ suspended: true })
    expect((await request(app).get("/products").set(b.auth)).status).toBe(200)
    expect((await request(app).get("/platform/companies").set(owner.auth)).status).toBe(200)

    // aunque el dueño pertenezca a la empresa suspendida, no queda bloqueado
    await prisma.membership.create({ data: { userId: owner.user.id, companyId: a.companyId, role: "ADMIN" } })
    const login = await request(app).post("/auth/switch-company").set(owner.auth).send({ companyId: a.companyId })
    expect((await request(app).get("/products").set({ Authorization: `Bearer ${login.body.token}` })).status).toBe(200)
  })

  it("empresa inexistente da error claro", async () => {
    const id = "00000000-0000-0000-0000-000000000000"
    expect((await request(app).patch(`/platform/companies/${id}/plan`).set(owner.auth).send({ plan: "PRO" })).status).toBe(400)
    expect((await request(app).patch(`/platform/companies/${id}/suspension`).set(owner.auth).send({ suspended: true })).status).toBe(400)
  })

  it("el perfil informa si eres dueño de la plataforma (para mostrar el menú)", async () => {
    const admin = await createUser("ADMIN")
    expect((await request(app).get("/profile/me").set(owner.auth)).body.isPlatformOwner).toBe(true)
    expect((await request(app).get("/profile/me").set(admin.auth)).body.isPlatformOwner).toBe(false)
  })
})

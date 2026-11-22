// Facturación como servicio, parte 2: primeros pasos del plan Solo facturación y monitoreo de comprobantes
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { createUser, resetDb } from "../../test/helpers.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Facturación como servicio — parte 2", () => {
  let owner: User, client: User, other: User
  let serviceId: string, customerId: string
  const invoice = async () =>
    (await request(app).post("/sales/invoices").set(client.auth)
      .send({ customerId, lines: [{ productId: serviceId, quantity: 1 }], payment: { method: "TRANSFER" } })).body.document.id as string
  const steps = async () => (await request(app).get("/company/onboarding").set(client.auth)).body

  beforeAll(async () => {
    await resetDb()
    owner = await createUser("ADMIN")
    await prisma.user.update({ where: { id: owner.user.id }, data: { isPlatformOwner: true } })
    client = await createUser("ADMIN")
    await prisma.user.update({ where: { id: client.user.id }, data: { plan: "INVOICING" } })
    other = await createUser("ADMIN")
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("los primeros pasos del plan Solo facturación llevan hasta la primera factura aceptada", async () => {
    let s = await steps()
    expect(s.mode).toBe("invoicing")
    expect(s.steps.map((x: { key: string }) => x.key)).toEqual(["fiscal", "einvoice", "catalog", "customer", "firstInvoice"])
    expect(s.completed).toBe(0)

    const categoryId = (await prisma.category.create({ data: { companyId: client.companyId, name: "General" } })).id
    serviceId = (await request(app).post("/products").set(client.auth)
      .send({ name: "Asesoría contable", price: 33900, stock: 0, minStock: 0, categoryId, isService: true, cabys: "8212000000000" })).body.id
    customerId = (await request(app).post("/customers").set(client.auth)
      .send({ name: "Panadería La Espiga", idType: "FISICA", idNumber: "112340567" })).body.id
    s = await steps()
    const done = Object.fromEntries(s.steps.map((x: { key: string; done: boolean }) => [x.key, x.done]))
    expect(done).toMatchObject({ catalog: true, customer: true, firstInvoice: false, einvoice: false })

    const docId = await invoice()
    await prisma.eInvoice.create({ data: { companyId: client.companyId, documentId: docId, environment: "pruebas", status: "ACCEPTED" } })
    expect((await steps()).steps.find((x: { key: string }) => x.key === "firstInvoice").done).toBe(true)
  })

  it("el plan completo sigue con su guía de siempre", async () => {
    const res = await request(app).get("/company/onboarding").set(other.auth)
    expect(res.body.mode).toBeUndefined()
    expect(res.body.steps.map((x: { key: string }) => x.key)).toContain("firstRegister")
  })

  it("el panel de plataforma ve los comprobantes con problemas (sin montos ni clientes) y las llaves por vencer", async () => {
    const hour = 3_600_000
    const rejected = await invoice(), error = await invoice(), retrying = await invoice(), silent = await invoice(), fine = await invoice(), freshSent = await invoice()
    await prisma.eInvoice.createMany({
      data: [
        { companyId: client.companyId, documentId: rejected, environment: "pruebas", status: "REJECTED", message: "-37 La cédula del receptor no es válida" },
        { companyId: client.companyId, documentId: error, environment: "pruebas", status: "ERROR", lastError: "Línea 1: falta el código CABYS" },
        { companyId: client.companyId, documentId: retrying, environment: "pruebas", status: "PENDING", attempts: 4, lastError: "Hacienda no responde" },
        { companyId: client.companyId, documentId: silent, environment: "pruebas", status: "SENT", sentAt: new Date(Date.now() - 2 * hour) },
        { companyId: client.companyId, documentId: fine, environment: "pruebas", status: "PENDING", attempts: 1 },
        { companyId: client.companyId, documentId: freshSent, environment: "pruebas", status: "SENT", sentAt: new Date() },
      ],
    })
    await prisma.eInvoiceSettings.create({
      data: { companyId: client.companyId, enabled: true, keyExpiresAt: new Date(Date.now() + 10 * 24 * hour) },
    })

    // solo el dueño de la plataforma
    expect((await request(app).get("/platform/einvoice-issues").set(client.auth)).status).toBe(403)
    const res = await request(app).get("/platform/einvoice-issues").set(owner.auth)
    expect(res.status).toBe(200)
    const byDoc = new Map(res.body.issues.map((i: { consecutive: string; kind: string }) => [i.consecutive, i.kind]))
    const consecutive = async (id: string) => (await prisma.document.findUniqueOrThrow({ where: { id } })).consecutive
    expect(byDoc.get(await consecutive(rejected))).toBe("REJECTED")
    expect(byDoc.get(await consecutive(error))).toBe("ERROR")
    expect(byDoc.get(await consecutive(retrying))).toBe("RETRYING")
    expect(byDoc.get(await consecutive(silent))).toBe("NO_ANSWER")
    expect(byDoc.has(await consecutive(fine))).toBe(false)
    expect(byDoc.has(await consecutive(freshSent))).toBe(false)
    expect(res.body.issues[0]).not.toHaveProperty("total")
    expect(res.body.issues.find((i: { kind: string }) => i.kind === "REJECTED").reason).toContain("-37")
    expect(res.body.byCompany).toEqual([{ company: { id: client.companyId, name: expect.any(String) }, count: 4 }])
    expect(res.body.expiringKeys).toEqual([expect.objectContaining({ company: expect.objectContaining({ id: client.companyId }), expired: false })])
  })
})

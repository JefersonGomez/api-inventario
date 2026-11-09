// Fase 5: foto del producto (subida como los avatares, se ve en Productos y en el POS)
import fs from "node:fs"
import path from "node:path"
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const onDisk = (url: string) => fs.existsSync(path.join(process.cwd(), url))
const files = () => fs.readdirSync("uploads/products").filter((f) => f !== ".gitkeep").length

describe("Foto del producto", () => {
  let admin: User, cashier: User, other: User, productId: string
  const upload = (u: User, id: string, data: Buffer = PNG, filename = "foto.png", contentType = "image/png") =>
    request(app).post(`/products/${id}/image`).set(u.auth).attach("image", data, { filename, contentType })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    cashier = await createUser("CASHIER", c)
    other = await createUser("ADMIN") // otra empresa
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "MRT", name: "Martillo", price: 5500, stock: 3, minStock: 0, categoryId: category.id, locationId: await mainLocationId(c) })).body.id
  })

  afterAll(async () => {
    // lo que haya quedado de estas pruebas
    for (const p of await prisma.product.findMany({ where: { imageUrl: { not: null } }, select: { imageUrl: true } })) {
      fs.rmSync(path.join(process.cwd(), p.imageUrl!), { force: true })
    }
    await resetDb()
    await prisma.$disconnect()
  })

  it("sube la foto con extensión segura y la devuelve en el producto, la lista y el catálogo del POS", async () => {
    const res = await upload(admin, productId, PNG, "evil.html")
    expect(res.status).toBe(200)
    expect(res.body.imageUrl).toMatch(/^\/uploads\/products\/[\w-]+\.png$/)
    expect(onDisk(res.body.imageUrl)).toBe(true)
    const list = await request(app).get("/products?view=flat").set(admin.auth)
    expect(list.body.items.find((p: { id: string }) => p.id === productId).imageUrl).toBe(res.body.imageUrl)
    // auditoría del cambio
    expect(await prisma.auditLog.count({ where: { entityType: "Product", entityId: productId, action: "UPDATE" } })).toBeGreaterThan(0)
  })

  it("al cambiarla borra la anterior; al quitarla borra el archivo", async () => {
    const first = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).imageUrl!
    const second = (await upload(admin, productId)).body.imageUrl
    expect(second).not.toBe(first)
    expect(onDisk(first)).toBe(false)
    expect(onDisk(second)).toBe(true)

    const removed = await request(app).delete(`/products/${productId}/image`).set(admin.auth)
    expect(removed.status).toBe(200)
    expect(removed.body.imageUrl).toBeNull()
    expect(onDisk(second)).toBe(false)
  })

  it("solo quien maneja productos, solo de su empresa, y solo imágenes de verdad (sin dejar archivos)", async () => {
    const before = files()
    expect((await upload(cashier, productId)).status).toBe(403)
    expect((await upload(other, productId)).status).toBe(404) // el producto es de otra empresa
    const fake = await upload(admin, productId, Buffer.from("<script>alert(1)</script>"), "foto.png", "image/png")
    expect(fake.status).toBe(400)
    expect((await upload(admin, productId, PNG, "foto.gif", "image/gif")).status).toBe(400)
    expect(files()).toBe(before)
    expect((await request(app).delete(`/products/${productId}/image`).set(cashier.auth)).status).toBe(403)
  })
})

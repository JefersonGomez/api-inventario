// Bloque 1B: variantes = productos normales agrupados bajo un producto base
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Productos base y variantes", () => {
  let admin: User
  let categoryId: string
  let groupId: string

  const variant = (sku: string, attributes: Record<string, string>, extra: object = {}) =>
    request(app).post("/products").set(admin.auth)
      .send({ sku, name: `Camisa polo ${sku}`, price: 9500, stock: 3, minStock: 1, categoryId, groupId, attributes, ...extra })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    categoryId = (await prisma.category.create({ data: { name: "Ropa", companyId: admin.companyId } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("crea el producto base con sus atributos y no repite el nombre", async () => {
    const res = await request(app).post("/product-groups").set(admin.auth).send({ name: "Camisa polo", attributeNames: ["Talla", "Color"] })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: "Camisa polo", attributeNames: ["Talla", "Color"], _count: { products: 0 } })
    groupId = res.body.id
    expect((await request(app).post("/product-groups").set(admin.auth).send({ name: "camisa POLO", attributeNames: ["Talla"] })).status).toBe(400)
    expect((await request(app).post("/product-groups").set(admin.auth).send({ name: "Sin atributos", attributeNames: [] })).status).toBe(400)
  })

  it("cada variante es un producto con su stock; exige todos los atributos y no repite la combinación", async () => {
    const m = await variant("POLO-M-R", { Talla: "M", Color: "Rojo" })
    expect(m.status).toBe(201)
    expect(m.body).toMatchObject({ groupId, attributes: { Talla: "M", Color: "Rojo" }, stock: 3, group: { name: "Camisa polo" } })

    expect((await variant("POLO-L-R", { Talla: "L", Color: "Rojo" })).status).toBe(201)
    const missing = await variant("POLO-X", { Talla: "S" })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toMatch(/Color/)
    const twin = await variant("POLO-M-R2", { Talla: "m", Color: "rojo" })
    expect(twin.status).toBe(400)
    expect(twin.body.error).toMatch(/Ya existe esa variante/)
    expect((await variant("POLO-Z", { Talla: "M", Color: "Azul", Manga: "Larga" })).status).toBe(400)

    // la variante funciona como cualquier producto: sus movimientos son propios
    const move = await request(app).post("/movements").set(admin.auth).send({ productId: m.body.id, type: "OUT", quantity: 2 })
    expect(move.status).toBe(201)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: m.body.id } })).stock)).toBe(1)
  })

  it("editar: cambia sus valores, puede dejar de ser variante, y el grupo cuenta sus variantes", async () => {
    const p = await variant("POLO-S-N", { Talla: "S", Color: "Negro" })
    const base = { name: "Camisa polo S negra", price: 9500, minStock: 1, categoryId }
    const toXL = await request(app).put(`/products/${p.body.id}`).set(admin.auth).send({ ...base, groupId, attributes: { Talla: "XL", Color: "Negro" } })
    expect(toXL.body.attributes).toEqual({ Talla: "XL", Color: "Negro" })

    const groups = await request(app).get("/product-groups").set(admin.auth)
    expect(groups.body[0]._count.products).toBe(3)

    const loose = await request(app).put(`/products/${p.body.id}`).set(admin.auth).send({ ...base, groupId: null })
    expect(loose.body).toMatchObject({ groupId: null, attributes: null })
    // sin groupId en el cuerpo, la variante no se toca
    const untouched = await request(app).put(`/products/${p.body.id}`).set(admin.auth).send(base)
    expect(untouched.body.groupId).toBeNull()
  })

  it("no deja quitar un atributo en uso; borrar el producto base deja las variantes como productos sueltos", async () => {
    const shrink = await request(app).put(`/product-groups/${groupId}`).set(admin.auth).send({ name: "Camisa polo", attributeNames: ["Talla"] })
    expect(shrink.status).toBe(400)
    expect(shrink.body.error).toMatch(/Color/)

    expect((await request(app).delete(`/product-groups/${groupId}`).set(admin.auth)).status).toBe(204)
    const left = await prisma.product.findMany({ where: { companyId: admin.companyId, sku: { startsWith: "POLO" } } })
    expect(left.length).toBeGreaterThan(0)
    expect(left.every((p) => p.groupId === null && p.deletedAt === null)).toBe(true)
    expect((await request(app).get("/product-groups").set(admin.auth)).body).toHaveLength(0)
  })
})

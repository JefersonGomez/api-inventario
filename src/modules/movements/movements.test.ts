import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"

describe("POST /movements", () => {
  let token: string
  let categoryId: string
  let productId: string

  beforeAll(async () => {
    await resetDb()
    const admin = await createUser("ADMIN")
    token = admin.token

    const category = await prisma.category.create({
      data: { name: "Categoria Test Movements", companyId: admin.companyId }
    })
    categoryId = category.id

    const product = await prisma.product.create({
      data: {
        companyId: admin.companyId,
        sku: "TEST-MOV-001",
        name: "Producto Test Movements",
        price: 10.0,
        stock: 20,
        minStock: 5,
        categoryId: categoryId
      }
    })
    productId = product.id
    // el stock vive en una ubicación: los 20 están en la principal
    await prisma.productStock.create({
      data: { companyId: admin.companyId, productId, locationId: await mainLocationId(admin.companyId), quantity: 20 },
    })
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("debería registrar una entrada (IN) y aumentar el stock", async () => {
    const response = await request(app)
      .post("/movements/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId,
        type: "IN",
        quantity: 10,
        reason: "Compra a proveedor"
      })

       console.log(JSON.stringify(response.body, null, 2))

    expect(response.status).toBe(201)

    const updatedProduct = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(updatedProduct?.stock)).toBe(30) // 20 inicial + 10
  })

  it("debería rechazar una salida (OUT) que dejaría stock negativo", async () => {
    const response = await request(app)
      .post("/movements/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId,
        type: "OUT",
        quantity: 9999,
        reason: "Venta grande"
      })

    expect(response.status).toBe(400)

    // Confirmamos que el stock NO cambió, ya que la transacción no debió ejecutarse
    const unchangedProduct = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(unchangedProduct?.stock)).toBe(30)
  })

  it("debería aplicar un ADJUSTMENT como valor final exacto", async () => {
    const response = await request(app)
      .post("/movements/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId,
        type: "ADJUSTMENT",
        quantity: 50,
        reason: "Conteo físico"
      })

    expect(response.status).toBe(201)

    const adjustedProduct = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(adjustedProduct?.stock)).toBe(50)
  })
})
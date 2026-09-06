import request from "supertest"
import bcrypt from "bcrypt"
import app from "../../app.ts"
import { prisma } from "../../config/database.ts"

describe("POST /movements", () => {
  const adminEmail = "movements-admin@example.com"
  const adminPassword = "123456"

  let token: string
  let categoryId: string
  let productId: string

  beforeAll(async () => {
    // Creamos un admin directo con Prisma (el registro público solo crea EMPLOYEE)
    const passwordHash = await bcrypt.hash(adminPassword, 10)
    await prisma.user.create({
      data: {
        name: "Movements Admin",
        email: adminEmail,
        passwordHash,
        role: "ADMIN"
      }
    })

    const loginResponse = await request(app).post("/auth/login").send({
      email: adminEmail,
      password: adminPassword
    })
    token = loginResponse.body.token

    const category = await prisma.category.create({
      data: { name: "Categoria Test Movements" }
    })
    categoryId = category.id

    const product = await prisma.product.create({
      data: {
        sku: "TEST-MOV-001",
        name: "Producto Test Movements",
        price: 10.0,
        stock: 20,
        minStock: 5,
        categoryId: categoryId
      }
    })
    productId = product.id
  })

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { productId } })
    await prisma.product.deleteMany({ where: { id: productId } })
    await prisma.category.deleteMany({ where: { id: categoryId } })
    await prisma.user.deleteMany({ where: { email: adminEmail } })
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
    expect(updatedProduct?.stock).toBe(30) // 20 inicial + 10
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
    expect(unchangedProduct?.stock).toBe(30)
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
    expect(adjustedProduct?.stock).toBe(50)
  })
})
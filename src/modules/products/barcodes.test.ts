// Bloque 5D: EAN y códigos internos para etiquetas
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { eanCheckDigit, internalEan, isValidEan } from "../../shared/ean.ts"

describe("Códigos de barras", () => {
  it("dígito verificador EAN con códigos reales", () => {
    expect(eanCheckDigit("400638133393")).toBe(1) // EAN-13 4006381333931
    expect(eanCheckDigit("590123412345")).toBe(7) // EAN-13 5901234123457
    expect(eanCheckDigit("9638507")).toBe(4) // EAN-8 96385074
    expect(eanCheckDigit("03600029145")).toBe(2) // UPC-A 036000291452
    expect(isValidEan("4006381333931")).toBe(true)
    expect(isValidEan("4006381333932")).toBe(false)
    expect(isValidEan("ABC")).toBe(false)
    expect(internalEan(1)).toBe("2000000000015")
    expect(isValidEan(internalEan(123456))).toBe(true)
  })

  describe("generar códigos para productos sin código", () => {
    let admin: Awaited<ReturnType<typeof createUser>>
    let categoryId: string
    beforeAll(async () => {
      await resetDb()
      admin = await createUser("ADMIN")
      categoryId = (await prisma.category.create({ data: { companyId: admin.companyId, name: "General" } })).id
    })
    afterAll(async () => {
      await resetDb()
      await prisma.$disconnect()
    })

    it("asigna EAN-13 internos seguidos, sin tocar los que ya tienen ni reutilizar los de eliminados", async () => {
      const make = (sku: string, barcode?: string, deletedAt?: Date) =>
        prisma.product.create({ data: { companyId: admin.companyId, sku, name: sku, price: 1, categoryId, ...(barcode && { barcode }), ...(deletedAt && { deletedAt }) } })
      const withCode = await make("A", "7501234567893")
      await make("B-OLD", internalEan(5), new Date()) // eliminado: su código ya pudo haberse impreso
      const b = await make("B")
      const c = await make("C")

      const res = await request(app).post("/products/barcodes").set(admin.auth).send({})
      expect(res.body.generated).toBe(2)
      const codes = (await prisma.product.findMany({ where: { id: { in: [b.id, c.id] } }, orderBy: { sku: "asc" } })).map((p) => p.barcode)
      expect(codes).toEqual([internalEan(6), internalEan(7)])
      expect((await prisma.product.findUniqueOrThrow({ where: { id: withCode.id } })).barcode).toBe("7501234567893")

      // solo los indicados
      const d = await make("D")
      await make("E")
      const only = await request(app).post("/products/barcodes").set(admin.auth).send({ productIds: [d.id] })
      expect(only.body.products).toEqual([{ id: d.id, barcode: internalEan(8) }])

      const employee = await createUser("EMPLOYE", admin.companyId)
      expect((await request(app).post("/products/barcodes").set(employee.auth).send({})).status).toBe(403)
    })
  })
})

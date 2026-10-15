// Bloque 1B: modelo de comprobantes (sin rutas todavía: se prueba el service con la empresa activa)
import { resetDb, createUser } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { runWithCompany } from "../../shared/tenant.ts"
import { buildConsecutive, computeLine, getDocument, issueDocument } from "./document.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Comprobantes", () => {
  let admin: User
  let cheese: string // precio 4520 con IVA 13 %, por kg
  let rice: string // precio 1150, exento
  let identified: string
  let creditCustomer: string
  const as = <T>(fn: () => Promise<T>) => runWithCompany(admin.companyId, fn)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const companyId = admin.companyId
    const cat = await prisma.category.create({ data: { name: "Abarrotes", companyId } })
    cheese = (await prisma.product.create({ data: { companyId, sku: "Q", name: "Queso", price: 4520, unit: "KG", taxRate: "RATE_13", cabys: "2391000000000", stock: 10, categoryId: cat.id } })).id
    rice = (await prisma.product.create({ data: { companyId, sku: "A", name: "Arroz", price: 1150, taxRate: "EXEMPT", stock: 10, categoryId: cat.id } })).id
    identified = (await prisma.customer.create({ data: { companyId, name: "Cliente con cédula", idType: "FISICA", idNumber: "112340567" } })).id
    creditCustomer = (await prisma.customer.create({ data: { companyId, name: "Con crédito", idType: "JURIDICA", idNumber: "3101123456", creditLimit: 100000, creditDays: 30 } })).id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("separa base e IVA de un precio que lo incluye (5 decimales)", () => {
    const l = computeLine(1, { quantity: 2, unitPriceWithTax: 1130, taxRate: "RATE_13" })
    expect(l.unitPrice.toNumber()).toBe(1000)
    expect(l.subtotal.toNumber()).toBe(2000)
    expect(l.taxAmount.toNumber()).toBe(260)
    expect(l.total.toNumber()).toBe(2260)

    const d = computeLine(2, { quantity: 1, unitPriceWithTax: 1130, discountWithTax: 113, taxRate: "RATE_13" })
    expect([d.discount.toNumber(), d.subtotal.toNumber(), d.taxAmount.toNumber(), d.total.toNumber()]).toEqual([100, 900, 117, 1017])

    expect(computeLine(3, { quantity: 1, unitPriceWithTax: 500, taxRate: "EXEMPT" }).taxAmount.toNumber()).toBe(0)
    expect(() => computeLine(4, { quantity: 1, unitPriceWithTax: 100, discountWithTax: 150, taxRate: "RATE_13" })).toThrow(/descuento/)
  })

  it("arma el consecutivo de Hacienda (sucursal 3 + terminal 5 + tipo 2 + número 10)", () => {
    expect(buildConsecutive("1", "1", "TICKET", 42)).toBe("00100001040000000042")
    expect(buildConsecutive("001", "00001", "INVOICE", 1)).toHaveLength(20)
  })

  it("emite un tiquete: líneas desde el producto, totales, pagos y consecutivo que avanza", async () => {
    const doc = await as(() => issueDocument({
      type: "TICKET",
      lines: [{ productId: cheese, quantity: 0.5 }, { productId: rice, quantity: 2 }],
      payments: [{ method: "CASH", amount: 4000 }, { method: "SINPE", amount: 560 }],
    }, admin.user.id))
    expect(doc.consecutive).toBe("00100001040000000001")
    const full = await as(() => getDocument(doc.id))
    expect(full.lines).toHaveLength(2)
    expect(full.lines[0]).toMatchObject({ description: "Queso", unit: "KG", taxRate: "RATE_13", cabys: "2391000000000" })
    // 0,5 kg × 4520 = 2260 con IVA → 2000 + 260; arroz exento 2 × 1150 = 2300
    expect(Number(full.lines[0]!.subtotal)).toBe(2000)
    expect(Number(full.taxTotal)).toBe(260)
    expect(Number(full.total)).toBe(4560)
    expect(full.currency).toBe("CRC")
    expect(full.payments.map((p) => p.method).sort()).toEqual(["CASH", "SINPE"])
  })

  it("los pagos tienen que sumar el total", async () => {
    await expect(as(() => issueDocument({
      type: "TICKET", lines: [{ productId: rice, quantity: 1 }], payments: [{ method: "CASH", amount: 1000 }],
    }, admin.user.id))).rejects.toThrow(/no suman el total/)
    const ok = await as(() => issueDocument({
      type: "TICKET", lines: [{ productId: rice, quantity: 1 }], payments: [{ method: "CARD", amount: 1150 }],
    }, admin.user.id))
    expect(ok.number).toBe(2)
  })

  it("factura solo con cliente identificado; crédito solo con cliente con crédito", async () => {
    await expect(as(() => issueDocument({ type: "INVOICE", lines: [{ productId: rice, quantity: 1 }] }, admin.user.id)))
      .rejects.toThrow(/cliente con identificación/)
    const inv = await as(() => issueDocument({ type: "INVOICE", customerId: identified, lines: [{ productId: rice, quantity: 1 }] }, admin.user.id))
    expect(inv.consecutive).toBe("00100001010000000001") // la numeración es por tipo

    await expect(as(() => issueDocument({ type: "INVOICE", customerId: identified, saleCondition: "CREDIT", lines: [{ productId: rice, quantity: 1 }] }, admin.user.id)))
      .rejects.toThrow(/crédito autorizado/)
    const credit = await as(() => issueDocument({ type: "INVOICE", customerId: creditCustomer, saleCondition: "CREDIT", lines: [{ productId: rice, quantity: 1 }] }, admin.user.id))
    expect((await as(() => getDocument(credit.id))).creditDays).toBe(30)
  })

  it("por unidad no acepta fracciones; línea libre necesita descripción y precio", async () => {
    await expect(as(() => issueDocument({ type: "TICKET", lines: [{ productId: rice, quantity: 1.5 }] }, admin.user.id))).rejects.toThrow(/entero/)
    await expect(as(() => issueDocument({ type: "TICKET", lines: [{ quantity: 1, unitPriceWithTax: 100 }] }, admin.user.id))).rejects.toThrow(/descripción/)
    const free = await as(() => issueDocument({ type: "TICKET", lines: [{ quantity: 1, description: "Servicio de corte", unitPriceWithTax: 565 }] }, admin.user.id))
    expect(Number(free.total)).toBe(565)
  })

  it("nota de crédito: referencia obligatoria, motivo, y no supera el saldo del original", async () => {
    const sale = await as(() => issueDocument({ type: "TICKET", lines: [{ productId: rice, quantity: 4 }] }, admin.user.id)) // 4600
    await expect(as(() => issueDocument({ type: "CREDIT_NOTE", lines: [{ productId: rice, quantity: 1 }] }, admin.user.id))).rejects.toThrow(/comprobante que corrige/)
    await expect(as(() => issueDocument({ type: "CREDIT_NOTE", referenceDocumentId: sale.id, lines: [{ productId: rice, quantity: 1 }] }, admin.user.id))).rejects.toThrow(/motivo/)

    const nc = await as(() => issueDocument({ type: "CREDIT_NOTE", referenceDocumentId: sale.id, referenceReason: "Devolución", lines: [{ productId: rice, quantity: 3 }] }, admin.user.id))
    expect(nc.consecutive.slice(8, 10)).toBe("03")
    await expect(as(() => issueDocument({ type: "CREDIT_NOTE", referenceDocumentId: sale.id, referenceReason: "Otra", lines: [{ productId: rice, quantity: 2 }] }, admin.user.id)))
      .rejects.toThrow(/supera el saldo/)
    await expect(as(() => issueDocument({ type: "CREDIT_NOTE", referenceDocumentId: nc.id, referenceReason: "x", lines: [{ productId: rice, quantity: 1 }] }, admin.user.id)))
      .rejects.toThrow(/no sobre otra nota/)
    await expect(as(() => issueDocument({ type: "TICKET", referenceDocumentId: sale.id, lines: [{ productId: rice, quantity: 1 }] }, admin.user.id)))
      .rejects.toThrow(/Solo las notas/)
  })

  it("un comprobante emitido no se puede editar ni borrar (trigger en la base)", async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { companyId: admin.companyId } })
    await expect(prisma.document.update({ where: { id: doc.id }, data: { notes: "cambio" } })).rejects.toThrow(/no se pueden modificar/)
    await expect(prisma.document.delete({ where: { id: doc.id } })).rejects.toThrow(/no se pueden modificar/)
    const line = await prisma.documentLine.findFirstOrThrow({ where: { documentId: doc.id } })
    await expect(prisma.documentLine.update({ where: { id: line.id }, data: { quantity: 99 } })).rejects.toThrow(/no se pueden modificar/)
  })

  it("cada empresa lleva su propia numeración", async () => {
    const other = await createUser("ADMIN")
    const cat = await prisma.category.create({ data: { name: "X", companyId: other.companyId } })
    const p = await prisma.product.create({ data: { companyId: other.companyId, sku: "Z", name: "Z", price: 100, categoryId: cat.id } })
    const doc = await runWithCompany(other.companyId, () => issueDocument({ type: "TICKET", lines: [{ productId: p.id, quantity: 1 }] }, other.user.id))
    expect(doc.number).toBe(1)
    // y no puede usar productos de otra empresa
    await expect(runWithCompany(other.companyId, () => issueDocument({ type: "TICKET", lines: [{ productId: rice, quantity: 1 }] }, other.user.id)))
      .rejects.toThrow(/no existe/)
  })
})

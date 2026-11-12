// La mercadería de la factura de un proveedor entra al inventario (Bloque 9, punto 48 — parte 3):
//  - plan: cada línea del XML con el producto sugerido (lo que se eligió la vez pasada con ese proveedor,
//    o su código = código de barras / SKU, o un único producto con ese CABYS) y su costo por unidad;
//  - al confirmar: entra con su movimiento (origen SUPPLIER_INVOICE) en la ubicación elegida, recalcula el
//    costo promedio como la recepción de una orden y recuerda el emparejamiento para la próxima factura.
//  - "factor": cuántas unidades nuestras trae cada una del proveedor (caja de 50 → 50).
//  - Las líneas que no son mercadería (flete, servicios) se marcan como "no entra".
//  - Un producto que todavía no existe se puede crear desde aquí (nombre, precio, categoría).
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import type { UnitOfMeasure } from "../../generated/prisma/enums.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { UNIT_CODE } from "../einvoice/codes.ts"
import { createMovement } from "../movements/movements.service.ts"
import { createProduct } from "../products/products.service.ts"
import { parseSupplierInvoice, type ParsedLine } from "./supplier-xml.ts"

const D = Prisma.Decimal
type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })

// unidad del sistema por el código de Hacienda (Unid, Kg…); lo demás (cajas, paquetes, servicios) = unidad
const UNIT_BY_CODE = Object.fromEntries(Object.entries(UNIT_CODE).map(([unit, code]) => [code.toLowerCase(), unit])) as Record<string, UnitOfMeasure>
const unitOf = (code: string | null): UnitOfMeasure => UNIT_BY_CODE[(code ?? "").toLowerCase()] ?? "UNIT"
const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120)
// cómo se recuerda una línea: por el código del proveedor si trae, si no por su detalle
const keyOf = (l: ParsedLine) => (l.code ? `code:${l.code.trim()}` : `desc:${normalize(l.description)}`)

const productView = { id: true, name: true, sku: true, barcode: true, unit: true, cost: true, cabys: true } as const

async function loadInvoice(invoiceId: string) {
  const invoice = await prisma.supplierInvoice.findFirst({
    where: { id: invoiceId },
    select: { id: true, number: true, xml: true, voidedAt: true, creditable: true, stockReceivedAt: true, supplierId: true, supplier: { select: { name: true } } },
  })
  if (!invoice) throw fail("Factura no encontrada", 404)
  if (!invoice.xml) throw fail("Esta factura se registró a mano: no trae las líneas para entrar al inventario (regístralo en Movimientos)", 409, "STOCK_NO_XML")
  if (invoice.voidedAt) throw fail("La factura está anulada", 409, "STOCK_VOIDED")
  const parsed = parseSupplierInvoice(invoice.xml)
  const company = await getCompany()
  // en dólares con la empresa en colones: el costo pasa a colones con el tipo de cambio de la factura
  const fx = parsed.currency !== company.currency && parsed.currency === "USD" && parsed.exchangeRate > 1 ? parsed.exchangeRate : 1
  // costo por unidad del proveedor: sin IVA si da crédito fiscal; si no, el IVA es parte del costo
  const costOf = (l: ParsedLine) =>
    l.quantity > 0 ? new D(l.subtotal).plus(invoice.creditable ? 0 : l.tax).times(fx).div(l.quantity).toDecimalPlaces(4).toNumber() : 0
  return { invoice, parsed, costOf }
}

// Qué va a entrar: líneas del XML con el producto sugerido
export async function stockPlan(invoiceId: string) {
  const { invoice, parsed, costOf } = await loadInvoice(invoiceId)
  const maps = await prisma.supplierProductMap.findMany({
    where: { supplierId: invoice.supplierId, key: { in: parsed.lines.map(keyOf) }, product: { deletedAt: null } },
    select: { key: true, factor: true, product: { select: productView } },
  })
  const byKey = new Map(maps.map((m) => [m.key, m]))
  const lines = []
  for (const l of parsed.lines) {
    const remembered = byKey.get(keyOf(l))
    let suggestion: { product: unknown; factor: number; reason: string } | null = remembered
      ? { product: remembered.product, factor: remembered.factor.toNumber(), reason: "remembered" }
      : null
    if (!suggestion && l.code) {
      const byCode = await prisma.product.findFirst({ where: { deletedAt: null, OR: [{ barcode: l.code }, { sku: l.code }] }, select: productView })
      if (byCode) suggestion = { product: byCode, factor: 1, reason: "code" }
    }
    if (!suggestion && l.cabys) {
      const byCabys = await prisma.product.findMany({ where: { deletedAt: null, cabys: l.cabys }, select: productView, take: 2 })
      if (byCabys.length === 1) suggestion = { product: byCabys[0], factor: 1, reason: "cabys" }
    }
    lines.push({
      line: l.line, description: l.description, code: l.code, cabys: l.cabys, quantity: l.quantity,
      unit: l.unit, unitCost: costOf(l), rate: l.rate, suggestedUnit: unitOf(l.unit), suggestion,
    })
  }
  return {
    invoice: { id: invoice.id, number: invoice.number, supplier: invoice.supplier.name, receivedAt: invoice.stockReceivedAt },
    lines,
  }
}

const newProductSchema = z.object({
  name: z.string().trim().min(1, "El producto nuevo necesita un nombre").max(160),
  price: z.number().positive("El precio de venta debe ser mayor a 0"),
  categoryId: z.uuid("Elige la categoría del producto nuevo"),
  sku: z.string().trim().min(1).max(60).optional(),
})
export const receiveStockSchema = z.object({
  locationId: z.uuid().optional(), // sin indicar: la ubicación activa
  lines: z
    .array(z.object({
      line: z.number().int().positive(),
      skip: z.boolean().optional(), // flete, servicios: no entra al inventario
      productId: z.uuid().optional(),
      newProduct: newProductSchema.optional(),
      factor: z.number().positive().max(100_000).optional(), // unidades nuestras por cada una del proveedor
    }))
    .min(1),
})

// Entra al inventario
export async function receiveInvoiceStock(invoiceId: string, input: z.infer<typeof receiveStockSchema>, userId: string) {
  const { invoice, parsed, costOf } = await loadInvoice(invoiceId)
  if (invoice.stockReceivedAt) throw fail("La mercadería de esta factura ya entró al inventario", 409, "STOCK_DONE")
  const byLine = new Map(parsed.lines.map((l) => [l.line, l]))
  const chosen = input.lines.filter((c) => !c.skip)
  for (const c of input.lines) if (!byLine.has(c.line)) throw new Error(`La línea ${c.line} no es de esta factura`)
  if (!chosen.length) throw new Error("Elige al menos un producto que entre al inventario (o marca qué líneas no entran)")
  for (const c of chosen) {
    if (!c.productId && !c.newProduct) throw new Error(`Línea ${c.line} (${byLine.get(c.line)!.description}): elige el producto o márcala como que no entra`)
  }

  // productos nuevos: se crean primero, con el servicio de Productos (respeta límites del plan, SKU, categoría)
  const created = new Map<number, string>()
  for (const c of chosen) {
    if (c.productId || !c.newProduct) continue
    const l = byLine.get(c.line)!
    const product = await createProduct({
      sku: c.newProduct.sku ?? l.code ?? `PRV-${invoice.number.slice(-6)}-${l.line}`,
      name: c.newProduct.name, price: c.newProduct.price, categoryId: c.newProduct.categoryId,
      stock: 0, minStock: 0, unit: unitOf(l.unit), taxRate: l.rate, supplierId: invoice.supplierId,
      ...(l.cabys && /^\d{13}$/.test(l.cabys) && { cabys: l.cabys }),
    }, userId)
    created.set(c.line, product.id)
  }

  const reason = `Factura ${invoice.number.slice(-10)} de ${invoice.supplier.name}`
  const entered = await prisma.$transaction(async (tx) => {
    const done: { line: number; productId: string; quantity: number; unitCost: number }[] = []
    for (const c of chosen) {
      const l = byLine.get(c.line)!
      const productId = c.productId ?? created.get(c.line)!
      const product = await tx.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, name: true, stock: true, cost: true } })
      if (!product) throw new Error(`Línea ${c.line}: el producto no existe`)
      const factor = c.factor ?? 1
      const quantity = new D(l.quantity).times(factor).toDecimalPlaces(3).toNumber()
      const unitCost = new D(costOf(l)).div(factor).toDecimalPlaces(4).toNumber()
      // costo promedio ponderado con el stock de ANTES, igual que la recepción de una orden de compra
      const stockBefore = Number(product.stock)
      const newCost = product.cost !== null && stockBefore > 0
        ? (stockBefore * Number(product.cost) + quantity * unitCost) / (stockBefore + quantity)
        : unitCost
      await tx.product.update({ where: { id: product.id }, data: { cost: Number(newCost.toFixed(4)) } })
      try {
        await createMovement(product.id, userId, "IN", quantity, reason, tx, {
          source: "SUPPLIER_INVOICE", sourceId: invoice.id, ...(input.locationId && { locationId: input.locationId }),
          lotDefault: `FAC-${invoice.number.slice(-10)}`,
        })
      } catch (err) {
        throw new Error(`Línea ${c.line} (${l.description}): ${(err as Error).message}`)
      }
      // la próxima factura de este proveedor ya sabe a qué producto va esta línea
      await tx.supplierProductMap.upsert({
        where: { companyId_supplierId_key: { companyId: currentCompanyId(), supplierId: invoice.supplierId, key: keyOf(l) } },
        create: { companyId: currentCompanyId(), supplierId: invoice.supplierId, key: keyOf(l), productId: product.id, factor },
        update: { productId: product.id, factor },
      })
      done.push({ line: c.line, productId: product.id, quantity, unitCost })
    }
    await tx.supplierInvoice.update({ where: { id: invoice.id }, data: { stockReceivedAt: new Date(), stockReceivedById: userId } })
    await logAudit(userId, "UPDATE", "SupplierInvoice", invoice.id, {
      stockReceived: true, number: invoice.number, lines: done.length, skipped: input.lines.length - chosen.length, created: created.size,
    }, tx)
    return done
  })
  return { invoiceId: invoice.id, entered, created: created.size }
}

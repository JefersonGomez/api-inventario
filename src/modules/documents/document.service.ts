// Comprobantes (tiquete, factura, notas de crédito/débito). Por ahora solo el modelo y su emisión:
// las rutas llegan con el POS (Bloque 7) y el envío a Hacienda con el motor propio (Bloque 9).
//
// Reglas:
//  - Los precios de los productos INCLUYEN el IVA; al emitir se separa la base y el impuesto por
//    línea (5 decimales, como Hacienda). Las líneas guardan montos SIN IVA.
//  - Un comprobante emitido es inmutable (trigger en la base): se corrige con una nota que lo referencia.
//  - El consecutivo sale de DocumentSequence dentro de la misma transacción (dos ventas a la vez no
//    pueden tomar el mismo número) y se arma con el formato de Hacienda de 20 dígitos.
//  - Este módulo NO mueve stock: quien vende (POS) crea los movimientos SALE/RETURN en la misma `tx`.
import { prisma, type Db } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import type { DocumentType, PaymentMethod, SaleCondition, TaxRate, UnitOfMeasure } from "../../generated/prisma/enums.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { DOCUMENT_CODE, TAX_PERCENT } from "../../shared/fiscal.ts"
import { assertQuantityForUnit } from "../../shared/units.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"

const D = Prisma.Decimal
const r5 = (v: Prisma.Decimal) => v.toDecimalPlaces(5)

export type DocumentLineInput = {
  productId?: string
  quantity: number
  // sin producto (línea libre) van descripción y precio; con producto, opcionales (lo sobrescriben)
  description?: string
  unitPriceWithTax?: number
  discountWithTax?: number // monto de descuento de la línea, con IVA
  discountLabel?: string // naturaleza del descuento (el tipo usado)
  unit?: UnitOfMeasure
  taxRate?: TaxRate
  cabys?: string | null
  unitCost?: number // costo unitario al vender (para la ganancia; no va a Hacienda)
  sourceLineId?: string // nota de crédito: línea de la venta que corrige
  returnCondition?: "GOOD" | "DAMAGED" // nota de crédito: estado del producto devuelto
}

export type IssueDocumentInput = {
  type: DocumentType
  customerId?: string | null
  saleCondition?: SaleCondition
  lines: DocumentLineInput[]
  // reference: autorización del datáfono / comprobante SINPE; tendered: efectivo entregado (para el vuelto)
  payments?: { method: PaymentMethod; amount: number; reference?: string | null | undefined; tendered?: number | null | undefined }[]
  referenceDocumentId?: string | null // obligatorio en notas
  referenceReason?: string | null
  notes?: string | null
  branchCode?: string
  terminalCode?: string
  cashSessionId?: string // turno de caja del POS
  discountAuthorizedById?: string // encargado que autorizó los descuentos
  creditAuthorizedById?: string // encargado que autorizó el crédito
  creditDays?: number // venta a crédito: días hasta la última cuota
  returnAuthorizedById?: string // nota de crédito: encargado que autorizó la devolución
}

type Computed = {
  lineNumber: number
  productId: string | null
  description: string
  cabys: string | null
  unit: UnitOfMeasure
  quantity: Prisma.Decimal
  unitPrice: Prisma.Decimal
  discount: Prisma.Decimal
  discountLabel: string | null
  taxRate: TaxRate
  unitCost: number | null
  sourceLineId: string | null
  returnCondition: "GOOD" | "DAMAGED" | null
  taxAmount: Prisma.Decimal
  subtotal: Prisma.Decimal
  total: Prisma.Decimal
}

// Separa base e IVA de una línea cuyo precio incluye el impuesto
export function computeLine(
  lineNumber: number,
  l: { quantity: number; unitPriceWithTax: number; discountWithTax?: number; taxRate: TaxRate },
): Pick<Computed, "lineNumber" | "quantity" | "unitPrice" | "discount" | "taxAmount" | "subtotal" | "total"> {
  const factor = new D(1).plus(new D(TAX_PERCENT[l.taxRate]).div(100))
  const quantity = new D(l.quantity)
  const gross = quantity.times(l.unitPriceWithTax)
  const discountGross = new D(l.discountWithTax ?? 0)
  if (discountGross.isNegative() || discountGross.greaterThan(gross)) {
    throw new Error(`Línea ${lineNumber}: el descuento debe estar entre 0 y el total de la línea`)
  }
  const unitPrice = r5(new D(l.unitPriceWithTax).div(factor))
  const discount = r5(discountGross.div(factor))
  const subtotal = r5(quantity.times(unitPrice).minus(discount))
  const taxAmount = r5(subtotal.times(TAX_PERCENT[l.taxRate]).div(100))
  return { lineNumber, quantity, unitPrice, discount, subtotal, taxAmount, total: subtotal.plus(taxAmount) }
}

const pad = (v: string | number, n: number) => String(v).padStart(n, "0")
export const buildConsecutive = (branch: string, terminal: string, type: DocumentType, number: number) =>
  `${pad(branch, 3)}${pad(terminal, 5)}${DOCUMENT_CODE[type]}${pad(number, 10)}`

async function resolveLines(lines: DocumentLineInput[], client: Db): Promise<Computed[]> {
  if (lines.length === 0) throw new Error("El comprobante necesita al menos una línea")
  if (lines.length > 1000) throw new Error("Máximo 1000 líneas por comprobante")

  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))]
  const products = await client.product.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, price: true, unit: true, taxRate: true, cabys: true },
  })
  const byId = new Map(products.map((p) => [p.id, p]))

  return lines.map((l, i) => {
    const n = i + 1
    const p = l.productId ? byId.get(l.productId) : undefined
    if (l.productId && !p) throw new Error(`Línea ${n}: el producto no existe`)
    const description = (l.description ?? p?.name ?? "").trim()
    const unitPriceWithTax = l.unitPriceWithTax ?? (p ? Number(p.price) : undefined)
    if (!description) throw new Error(`Línea ${n}: falta la descripción`)
    if (unitPriceWithTax === undefined || !(unitPriceWithTax >= 0)) throw new Error(`Línea ${n}: falta un precio válido`)
    if (!(l.quantity > 0)) throw new Error(`Línea ${n}: la cantidad debe ser mayor que 0`)
    const unit = l.unit ?? p?.unit ?? "UNIT"
    const taxRate = l.taxRate ?? p?.taxRate ?? "RATE_13"
    assertQuantityForUnit(l.quantity, unit, `Línea ${n}: la cantidad`)
    return {
      ...computeLine(n, { quantity: l.quantity, unitPriceWithTax, taxRate, ...(l.discountWithTax !== undefined && { discountWithTax: l.discountWithTax }) }),
      productId: p?.id ?? null,
      description,
      cabys: l.cabys !== undefined ? l.cabys : (p?.cabys ?? null),
      discountLabel: l.discountWithTax ? (l.discountLabel?.slice(0, 80) ?? null) : null,
      unit,
      taxRate,
      unitCost: l.unitCost ?? null,
      sourceLineId: l.sourceLineId ?? null,
      returnCondition: l.returnCondition ?? null,
    }
  })
}

export async function issueDocument(input: IssueDocumentInput, userId: string, client?: Db) {
  const run = async (tx: Db) => {
    const { currency } = await getCompany()
    const type = input.type
    const saleCondition = input.saleCondition ?? "CASH"
    const isNote = type === "CREDIT_NOTE" || type === "DEBIT_NOTE"

    const customer = input.customerId
      ? await tx.customer.findFirst({ where: { id: input.customerId, deletedAt: null } })
      : null
    if (input.customerId && !customer) throw new Error("El cliente no existe")
    if (type === "INVOICE" && !(customer?.idType && customer.idNumber)) {
      throw new Error("La factura necesita un cliente con identificación (para un consumidor final usa tiquete)")
    }
    if (saleCondition === "CREDIT" && customer?.creditLimit == null) {
      throw new Error("La venta a crédito necesita un cliente con crédito autorizado")
    }

    const lines = await resolveLines(input.lines, tx)
    const sum = (k: "subtotal" | "discount" | "taxAmount" | "total") => lines.reduce((s, l) => s.plus(l[k]), new D(0))
    const totals = { subtotal: sum("subtotal"), discountTotal: sum("discount"), taxTotal: sum("taxAmount"), total: sum("total") }

    // notas: siempre contra un comprobante de venta de la empresa; la de crédito no puede devolver más de lo que queda
    if (isNote) {
      if (!input.referenceDocumentId) throw new Error("La nota necesita el comprobante que corrige")
      if (!input.referenceReason?.trim()) throw new Error("La nota necesita el motivo")
      const original = await tx.document.findFirst({ where: { id: input.referenceDocumentId } })
      if (!original) throw new Error("El comprobante de referencia no existe")
      if (original.type === "CREDIT_NOTE" || original.type === "DEBIT_NOTE") {
        throw new Error("Una nota se aplica sobre una factura o un tiquete, no sobre otra nota")
      }
      if (type === "CREDIT_NOTE") {
        const related = await tx.document.findMany({
          where: { referenceDocumentId: original.id },
          select: { type: true, total: true },
        })
        const balance = related.reduce(
          (b, d) => (d.type === "CREDIT_NOTE" ? b.minus(d.total) : b.plus(d.total)),
          new D(original.total)
        )
        // margen de un céntimo: separar el IVA otra vez en una devolución total puede mover el 5.º decimal
        if (totals.total.greaterThan(balance.plus(0.01))) {
          throw new Error(`La nota de crédito supera el saldo del comprobante (${balance.toFixed(2)})`)
        }
      }
    } else if (input.referenceDocumentId) {
      throw new Error("Solo las notas de crédito o débito llevan comprobante de referencia")
    }

    const payments = input.payments ?? []
    if (payments.some((p) => !(p.amount > 0))) throw new Error("Cada pago debe ser mayor que 0")
    // a crédito los pagos son la prima: pueden sumar menos que el total (el resto va a cuotas)
    if (payments.length) {
      const paid = payments.reduce((s, p) => s.plus(p.amount), new D(0))
      if (saleCondition === "CREDIT" ? paid.greaterThan(totals.total.plus(0.01)) : paid.minus(totals.total).abs().greaterThan(0.01)) {
        throw new Error(`Los pagos (${paid.toFixed(2)}) no suman el total (${totals.total.toFixed(2)})`)
      }
    }

    const companyId = currentCompanyId()
    const branchCode = input.branchCode ?? "001"
    const terminalCode = input.terminalCode ?? "00001"
    // el upsert toma el lock de la fila: dos emisiones simultáneas reciben números distintos
    const seq = await tx.documentSequence.upsert({
      where: { companyId_type_branchCode_terminalCode: { companyId, type, branchCode, terminalCode } },
      create: { companyId, type, branchCode, terminalCode, last: 1 },
      update: { last: { increment: 1 } },
    })

    const doc = await tx.document.create({
      data: {
        companyId,
        type,
        branchCode,
        terminalCode,
        number: seq.last,
        consecutive: buildConsecutive(branchCode, terminalCode, type, seq.last),
        customerId: customer?.id ?? null,
        saleCondition,
        creditDays: saleCondition === "CREDIT" ? (input.creditDays ?? customer?.creditDays ?? null) : null,
        currency,
        ...totals,
        referenceDocumentId: isNote ? input.referenceDocumentId! : null,
        referenceReason: isNote ? input.referenceReason!.trim() : null,
        notes: input.notes?.trim() || null,
        createdById: userId,
        lines: { createMany: { data: lines } },
        ...(input.cashSessionId && { cashSessionId: input.cashSessionId }),
        ...(input.discountAuthorizedById && { discountAuthorizedById: input.discountAuthorizedById }),
        ...(input.creditAuthorizedById && { creditAuthorizedById: input.creditAuthorizedById }),
        ...(input.returnAuthorizedById && { returnAuthorizedById: input.returnAuthorizedById }),
        ...(payments.length && {
          payments: {
            createMany: {
              data: payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference || null, tendered: p.tendered ?? null })),
            },
          },
        }),
      },
      select: { id: true, type: true, number: true, consecutive: true, total: true },
    })
    await logAudit(userId, "CREATE", "Document", doc.id, { type, consecutive: doc.consecutive, total: doc.total.toNumber() }, tx)
    return doc
  }
  return client ? run(client) : prisma.$transaction(run)
}

// Comprobante completo (fuera de la transacción: un include de varias relaciones adentro de una
// transacción hace que adapter-pg lance consultas en paralelo sobre la misma conexión)
export async function getDocument(id: string) {
  const doc = await prisma.document.findFirst({
    where: { id },
    include: {
      lines: { orderBy: { lineNumber: "asc" } },
      payments: true,
      customer: true,
      createdBy: { select: { id: true, name: true } },
      discountAuthorizedBy: { select: { id: true, name: true } },
      creditAuthorizedBy: { select: { id: true, name: true } },
      returnAuthorizedBy: { select: { id: true, name: true } },
      referenceDocument: { select: { id: true, consecutive: true, type: true, issuedAt: true } },
      installments: { orderBy: { number: "asc" } },
    },
  })
  if (!doc) throw new Error("Comprobante no encontrado")
  return doc
}

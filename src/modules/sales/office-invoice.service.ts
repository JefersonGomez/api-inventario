// Factura desde la oficina, sin caja (Bloque 9, punto 47; decisiones del usuario del 12-nov-2026):
//  - siempre es FACTURA electrónica a nombre de un cliente con cédula;
//  - la mercadería SALE del stock de la sucursal o bodega elegida (no se permite dejarlo en negativo);
//    también lleva líneas de servicio sin producto (flete, instalación) que no tocan el stock;
//  - de contado, el dinero entra a una CUENTA BANCARIA (transferencia, SINPE o tarjeta), no a una caja;
//    a crédito, cuotas como en la caja (con el límite y sin cuotas vencidas);
//  - plan "Solo facturación": no toca el stock (los productos son solo un catálogo) y cuenta para el cupo del mes;
//  - la emiten quienes tienen invoices.issue (administrador y encargado) y se envía sola a Hacienda.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { activeAccount } from "../banks/banks.service.ts"
import { assertDocumentQuota, invoicingOnly } from "../company/company.service.ts"
import { issueDocument, type DocumentLineInput } from "../documents/document.service.ts"
import { queueEInvoice } from "../einvoice/einvoice.service.ts"
import { resolveLocation } from "../locations/location.service.ts"
import { createMovement } from "../movements/movements.service.ts"
import { getTicket } from "../pos/pos.service.ts"
import { assertCreditAllowed, createCreditInstallments, creditPlanSchema, dueDates } from "../receivables/receivables.service.ts"

const D = Prisma.Decimal
type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })
// la oficina no es una caja: su propia numeración. Hacienda exige terminal de 00001 en adelante (con 00000
// rechazó la factura: -79 numeración consecutiva, 17-nov-2026); 99999 no choca con las cajas (empiezan en 00001)
const OFFICE_TERMINAL = "99999"

const money = z.number().min(0).max(1e12)
const lineSchema = z
  .object({
    productId: z.uuid().optional(),
    description: z.string().trim().min(1).max(200).optional(), // obligatorio en servicios; en productos cambia el nombre
    quantity: z.number().positive().max(1e9),
    unitPriceWithTax: money.optional(), // sin indicar: el precio del producto
    taxRate: z.enum(["EXEMPT", "RATE_1", "RATE_2", "RATE_4", "RATE_13"]).optional(),
    cabys: z.string().regex(/^\d{13}$/, "El CABYS tiene 13 dígitos").optional(),
  })
  .refine((l) => l.productId || (l.description && l.unitPriceWithTax !== undefined && l.taxRate && l.cabys), {
    message: "Una línea de servicio necesita descripción, precio, IVA y su CABYS (Hacienda lo exige en cada línea)",
  })

export const officeInvoiceSchema = z
  .object({
    customerId: z.uuid(),
    locationId: z.uuid().optional(), // de dónde sale la mercadería (sin indicar: la ubicación activa)
    lines: z.array(lineSchema).min(1).max(200),
    payment: z.object({
      method: z.enum(["TRANSFER", "SINPE", "CARD"]),
      reference: z.string().trim().max(60).optional(),
      bankAccountId: z.uuid().optional(), // sin indicar: la de la sucursal o la de la empresa (Bancos)
    }).optional(),
    credit: creditPlanSchema.optional(),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.payment) !== Boolean(v.credit), { message: "Elige de contado (con su forma de pago) o a crédito", path: ["payment"] })

type Actor = { id: string }

export async function issueOfficeInvoice(input: z.infer<typeof officeInvoiceSchema>, actor: Actor) {
  const customer = await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null } })
  if (!customer) throw fail("El cliente no existe", 404)
  if (!customer.idType || !customer.idNumber) {
    throw fail(`${customer.name} no tiene cédula: la factura electrónica la necesita (complétala en Clientes)`, 409, "INVOICE_CUSTOMER_ID")
  }
  const location = await resolveLocation(input.locationId)
  if (input.payment?.bankAccountId) await activeAccount(input.payment.bankAccountId)
  const creditCustomer = input.credit ? await assertCreditAllowed(customer.id) : null
  await assertDocumentQuota()
  const noStock = await invoicingOnly()

  // stock suficiente donde sale (aviso claro antes; el movimiento lo vuelve a revisar dentro de la transacción)
  const ids = [...new Set(input.lines.flatMap((l) => (l.productId ? [l.productId] : [])))]
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, cost: true, unit: true, cabys: true, isService: true, stocks: { where: { locationId: location.id }, select: { quantity: true } } },
  })
  // con el envío automático a Hacienda encendido, una línea sin CABYS quedaría "Con error": se avisa antes
  const einvoiceOn = await prisma.eInvoiceSettings.findFirst({ where: { enabled: true }, select: { id: true } })
  const noCabys = products.filter((p) => !p.cabys && !input.lines.some((l) => l.productId === p.id && l.cabys))
  if (einvoiceOn && noCabys.length) {
    throw fail(`Sin código CABYS (Hacienda lo exige): ${noCabys.map((p) => p.name).join(", ")}. Complétalo en Productos.`, 409, "INVOICE_CABYS")
  }
  const byId = new Map(products.map((p) => [p.id, p]))
  const wanted = new Map<string, Prisma.Decimal>()
  // los servicios del catálogo no llevan stock
  for (const l of input.lines) if (l.productId && !byId.get(l.productId)?.isService) wanted.set(l.productId, (wanted.get(l.productId) ?? new D(0)).plus(l.quantity))
  const short = [...wanted].flatMap(([id, qty]) => {
    const p = byId.get(id)
    if (!p) throw fail("Algún producto no existe", 404)
    const have = new D(p.stocks[0]?.quantity ?? 0)
    return qty.greaterThan(have) ? [`${p.name} (hay ${have.toNumber()}, se facturan ${qty.toNumber()})`] : []
  })
  if (short.length && !noStock) throw fail(`No alcanza el stock en ${location.name}: ${short.join(", ")}`, 409, "INVOICE_STOCK")

  const lines: DocumentLineInput[] = input.lines.map((l) => {
    const p = l.productId ? byId.get(l.productId)! : null
    return {
      ...(p && { productId: p.id }),
      ...(l.description && { description: l.description }),
      quantity: l.quantity,
      ...(l.unitPriceWithTax !== undefined && { unitPriceWithTax: l.unitPriceWithTax }),
      ...(l.taxRate && { taxRate: l.taxRate }),
      ...(l.cabys && { cabys: l.cabys }),
      ...(p?.cost != null && { unitCost: p.cost.toNumber() }), // el costo de hoy, para la ganancia
    }
  })

  const doc = await prisma.$transaction(async (tx) => {
    const doc = await issueDocument(
      {
        type: "INVOICE",
        customerId: customer.id,
        lines,
        ...(input.credit && {
          saleCondition: "CREDIT" as const,
          creditDays: Math.round((dueDates(input.credit).at(-1)!.getTime() - Date.now()) / 86_400_000),
          creditAuthorizedById: actor.id, // en la oficina autoriza quien factura (tiene invoices.issue)
        }),
        ...(input.notes && { notes: input.notes }),
        branchCode: location.code ?? "001",
        terminalCode: OFFICE_TERMINAL,
      },
      actor.id,
      tx
    )
    const total = new D(doc.total).toDecimalPlaces(2)
    if (input.credit) {
      await createCreditInstallments(tx, { id: doc.id, customerId: customer.id, amount: total, plan: input.credit, limit: new D(creditCustomer!.creditLimit!) })
    } else {
      // de contado: entra completo a la cuenta bancaria (no a una caja)
      await tx.documentPayment.create({
        data: {
          documentId: doc.id, method: input.payment!.method, amount: total, reference: input.payment!.reference || null,
          bankAccountId: input.payment!.bankAccountId ?? null,
        },
      })
    }
    for (const [productId, qty] of noStock ? [] : wanted) {
      await createMovement(productId, actor.id, "OUT", qty.toNumber(), `Factura ${doc.consecutive}`, tx, { source: "SALE", sourceId: doc.id, locationId: location.id })
    }
    return doc
  })
  queueEInvoice(doc.id) // a Hacienda sin hacer esperar (si el envío automático está encendido)
  return getTicket(doc.id)
}

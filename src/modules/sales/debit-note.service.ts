// Nota de débito (Bloque 9, punto 47): cobrarle al cliente un cargo extra sobre una factura o un tiquete
// ya emitidos (un flete olvidado, intereses, una diferencia de precio). Siempre son líneas de cargo con su
// CABYS (no mueven inventario). Se cobra como la factura de oficina: de contado a una cuenta bancaria o a
// crédito en cuotas. Va a Hacienda con referencia 04 cuando la venta original ya está aceptada.
// La emiten quienes tienen invoices.issue (administrador y encargado).
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { activeAccount } from "../banks/banks.service.ts"
import { assertDocumentQuota } from "../company/company.service.ts"
import { issueDocument } from "../documents/document.service.ts"
import { queueEInvoice } from "../einvoice/einvoice.service.ts"
import { getTicket } from "../pos/pos.service.ts"
import { assertCreditAllowed, createCreditInstallments, creditPlanSchema, dueDates } from "../receivables/receivables.service.ts"

const D = Prisma.Decimal
type HttpError = Error & { status?: number; code?: string }
const fail = (message: string, status: number, code?: string): HttpError => Object.assign(new Error(message), { status, ...(code && { code }) })
const OFFICE_TERMINAL = "99999" // misma numeración que la factura de oficina (Hacienda exige terminal 00001+)

export const debitNoteSchema = z
  .object({
    reason: z.string().trim().min(3, "Indica el motivo del cargo").max(180),
    lines: z
      .array(z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.number().positive().max(1e9),
        unitPriceWithTax: z.number().positive().max(1e12),
        taxRate: z.enum(["EXEMPT", "RATE_1", "RATE_2", "RATE_4", "RATE_13"]),
        cabys: z.string().regex(/^\d{13}$/, "Cada cargo necesita su CABYS de 13 dígitos (Hacienda lo exige)"),
      }))
      .min(1)
      .max(50),
    payment: z.object({
      method: z.enum(["TRANSFER", "SINPE", "CARD"]),
      reference: z.string().trim().max(60).optional(),
      bankAccountId: z.uuid().optional(),
    }).optional(),
    credit: creditPlanSchema.optional(),
  })
  .refine((v) => Boolean(v.payment) !== Boolean(v.credit), { message: "Elige de contado (con su forma de pago) o a crédito", path: ["payment"] })

export async function issueDebitNote(saleId: string, input: z.infer<typeof debitNoteSchema>, actor: { id: string }) {
  const original = await prisma.document.findFirst({ where: { id: saleId }, select: { id: true, type: true, branchCode: true, customerId: true } })
  if (!original) throw fail("Venta no encontrada", 404)
  if (original.type !== "TICKET" && original.type !== "INVOICE") throw fail("La nota de débito se hace sobre una factura o un tiquete", 409, "DEBIT_ORIGINAL")
  if (input.payment?.bankAccountId) await activeAccount(input.payment.bankAccountId)
  await assertDocumentQuota() // cuenta para el cupo del mes del plan
  const creditCustomer = input.credit ? await assertCreditAllowed(original.customerId ?? undefined) : null

  const doc = await prisma.$transaction(async (tx) => {
    const doc = await issueDocument(
      {
        type: "DEBIT_NOTE",
        customerId: original.customerId,
        referenceDocumentId: original.id,
        referenceReason: input.reason,
        lines: input.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceWithTax: l.unitPriceWithTax, taxRate: l.taxRate, cabys: l.cabys })),
        ...(input.credit && {
          saleCondition: "CREDIT" as const,
          creditDays: Math.round((dueDates(input.credit).at(-1)!.getTime() - Date.now()) / 86_400_000),
          creditAuthorizedById: actor.id,
        }),
        branchCode: original.branchCode,
        terminalCode: OFFICE_TERMINAL,
      },
      actor.id,
      tx
    )
    const total = new D(doc.total).toDecimalPlaces(2)
    if (input.credit) {
      await createCreditInstallments(tx, { id: doc.id, customerId: creditCustomer!.id, amount: total, plan: input.credit, limit: new D(creditCustomer!.creditLimit!) })
    } else {
      await tx.documentPayment.create({
        data: { documentId: doc.id, method: input.payment!.method, amount: total, reference: input.payment!.reference || null, bankAccountId: input.payment!.bankAccountId ?? null },
      })
    }
    return doc
  })
  queueEInvoice(doc.id) // sale sola cuando Hacienda tenga aceptada la venta original
  return getTicket(doc.id)
}

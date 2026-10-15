import { z } from "zod"
import { pageQuery, queryFlag } from "../../shared/pagination.ts"

// GET /purchase-requests: más recientes primero. q busca en el producto (nombre/SKU) y en quién pidió.
// unlinked = aprobadas que todavía no están en ninguna orden (las que se pueden pasar a una orden)
export const purchaseRequestListQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  unlinked: queryFlag,
})
export type PurchaseRequestListQuery = z.infer<typeof purchaseRequestListQuerySchema>
import { quantitySchema } from "../../shared/units.ts"

export const createPurchaseRequestSchema = z.object({
  productId: z.uuid(),
  quantity: quantitySchema,
  reason: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
})

export const updateStatusSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    // distinto de `reason` (el motivo que da quien pide); lo escribe el admin al rechazar
    rejectionReason: z.string().trim().min(1).max(300).optional(),
  })
  .refine((d) => d.status !== "REJECTED" || !!d.rejectionReason, {
    message: "Indica el motivo del rechazo",
    path: ["rejectionReason"],
  })
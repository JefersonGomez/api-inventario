import { z } from "zod"

export const createPurchaseRequestSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().positive(),
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
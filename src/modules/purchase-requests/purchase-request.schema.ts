import { z } from "zod"

export const createPurchaseRequestSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().positive(),
  reason: z.string().optional(),
})

export const updateStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
})
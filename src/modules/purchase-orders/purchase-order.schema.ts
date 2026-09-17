// purchase-order.schema.ts
import { z } from "zod";

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
        unitCost: z.number().positive(),
      })
    )
    .nonempty(),
    fulfilledRequestIds: z.array(z.string().uuid()).optional(),
});
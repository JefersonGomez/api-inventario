// purchase-order.schema.ts
import { z } from "zod";
import { quantitySchema } from "../../shared/units.ts";

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: quantitySchema,
        unitCost: z.number().positive(),
      })
    )
    .nonempty(),
    fulfilledRequestIds: z.array(z.string().uuid()).optional(),
});
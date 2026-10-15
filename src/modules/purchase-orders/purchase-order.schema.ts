// purchase-order.schema.ts
import { z } from "zod";
import { pageQuery } from "../../shared/pagination.ts";

// GET /purchase-orders: más recientes primero. q busca por proveedor o por el N.º de orden (inicio del id)
export const purchaseOrderListQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["PENDING", "RECEIVED", "CANCELLED"]).optional(),
  supplierId: z.string().uuid().optional(),
});
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;
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
// purchase-order.schema.ts
import { z } from "zod";
import { pageQuery } from "../../shared/pagination.ts";

// GET /purchase-orders: más recientes primero. q busca por proveedor o por el N.º de orden (inicio del id)
export const purchaseOrderListQuerySchema = z.object({
  ...pageQuery,
  status: z.enum(["PENDING", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]).optional(),
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
    locationId: z.uuid().optional(), // a dónde entra la mercadería al recibirla
});

// Recepción en partes: lo que llegó de cada línea. Sin cuerpo = todo lo pendiente.
export const receivePurchaseOrderSchema = z
  .object({ items: z.array(z.object({ itemId: z.uuid(), quantity: z.number().min(0) })).min(1) })
  .optional();
export const cancelPurchaseOrderSchema = z.object({ reason: z.string().trim().min(1, "Indica el motivo").max(300) });
export const closePurchaseOrderSchema = z.object({ reason: z.string().trim().max(300).optional() }).optional();
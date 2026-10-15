import { quantitySchema } from "../../shared/units.ts"
import { pageQuery } from "../../shared/pagination.ts"
import {z} from "zod"

// GET /movements: más recientes primero. q busca en el nombre/SKU del producto y en el motivo.
export const movementListQuerySchema = z.object({
    ...pageQuery,
    productId: z.uuid().optional(),
    type: z.enum(["IN", "OUT", "ADJUSTMENT"]).optional(),
    source: z.enum(["MANUAL", "INITIAL", "PURCHASE_RECEIPT", "SALE", "RETURN", "COUNT", "TRANSFER"]).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
})
export type MovementListQuery = z.infer<typeof movementListQuerySchema>

export const CreateMovementsSchema = z.object({
    productId:z.uuid(),
    type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
    quantity: quantitySchema,
    reason:z.string().optional()
})
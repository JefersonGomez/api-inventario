import { quantitySchema } from "../../shared/units.ts"
import {z} from "zod"

export const CreateMovementsSchema = z.object({
    productId:z.uuid(),
    type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
    quantity: quantitySchema,
    reason:z.string().optional()
})
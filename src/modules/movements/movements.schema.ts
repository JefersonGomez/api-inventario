import {z} from "zod"

export const CreateMovementsSchema = z.object({
    productId:z.uuid(),
    type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
    quantity:z.number().positive(),
    reason:z.string().optional()
})
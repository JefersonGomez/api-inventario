import { z } from "zod"

// Producto base de variantes: nombre + atributos que distinguen a cada variante ("Talla", "Color")
export const productGroupSchema = z.object({
  name: z.string().trim().min(1, "El nombre es requerido").max(160),
  attributeNames: z
    .array(z.string().trim().min(1).max(40))
    .min(1, "Indica al menos un atributo (por ejemplo, Talla)")
    .max(5, "Máximo 5 atributos")
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "Hay atributos repetidos"),
})

export type ProductGroupInput = z.infer<typeof productGroupSchema>

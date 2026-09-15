import { z } from "zod"

export const supplierSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  email: z.email("Email inválido").optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
})
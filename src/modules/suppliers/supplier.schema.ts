import { z } from "zod"
import { checkFiscalId, fiscalIdFields } from "../../shared/fiscal.ts"

// La identificación del proveedor sirve para reconocer sus facturas electrónicas (Bloque 9)
export const supplierSchema = z
  .object({
    name: z.string().min(1, "El nombre es requerido"),
    email: z.email("Email inválido").optional().or(z.literal("")),
    phone: z.string().optional(),
    address: z.string().optional(),
    creditDays: z.number().int().min(0).max(365).optional(), // plazo que nos da (0 = contado)
    ...fiscalIdFields,
  })
  .superRefine(checkFiscalId)

export type SupplierInput = z.infer<typeof supplierSchema>
import { z } from "zod"
import { checkFiscalId, fiscalIdFields } from "../../shared/fiscal.ts"

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()

export const customerSchema = z
  .object({
    name: z.string().trim().min(1, "El nombre es requerido").max(160),
    ...fiscalIdFields,
    email: z.email("Email inválido").nullable().optional().or(z.literal("")),
    phone: optionalText(30),
    address: optionalText(300),
    economicActivity: optionalText(20),
  })
  .superRefine(checkFiscalId)

export type CustomerInput = z.infer<typeof customerSchema>

import { z } from "zod"
import { PERMISSIONS } from "../../config/permissions.ts"

// Acceso de una persona en la empresa: su rol (fijo) + los ajustes solo para ella
const permission = z.enum(PERMISSIONS)

export const updateAccessSchema = z
  .object({
    role: z.enum(["ADMIN", "MANAGER", "EMPLOYE", "CASHIER", "ACCOUNTANT"]),
    grantedPermissions: z.array(permission).max(PERMISSIONS.length).default([]),
    revokedPermissions: z.array(permission).max(PERMISSIONS.length).default([]),
  })
  .refine((d) => !d.grantedPermissions.some((p) => d.revokedPermissions.includes(p)), {
    message: "Un permiso no puede estar dado y quitado a la vez",
  })

export type UpdateAccessInput = z.infer<typeof updateAccessSchema>

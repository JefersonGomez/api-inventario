import { z } from "zod"
import { newPasswordSchema } from "../../shared/password.ts"

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "La contraseña actual es requerida"),
  newPassword: newPasswordSchema,
})

export const updateProfileSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  email: z.email("Email inválido"),
})
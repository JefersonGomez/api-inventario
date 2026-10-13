import { z } from "zod"
import { newPasswordSchema } from "../../shared/password.ts"
import { TERMS_REQUIRED_MESSAGE } from "../../config/legal.ts"

export const registerSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  email: z.email("Email inválido"),
  password: newPasswordSchema,
  phone: z.string().trim().max(30).optional(),
  company: z.string().trim().max(120).optional(),
  // casilla obligatoria: sin aceptar no se crea la cuenta
  acceptTerms: z.literal(true, { error: TERMS_REQUIRED_MESSAGE }),
})

export const switchCompanySchema = z.object({
  companyId: z.uuid(),
})

export const loginSchema = z.object({
  email: z.email("Email inválido"),
  // sin la regla nueva: quien ya tiene una contraseña de 6 caracteres debe poder entrar
  password: z.string().min(1, "La contraseña es requerida").max(200)
})
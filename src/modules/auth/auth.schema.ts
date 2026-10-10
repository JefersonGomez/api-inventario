import { z } from "zod"

export const registerSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  email: z.email("Email inválido"),
  password: z.string().min(6, "La contraseña debe de tener al menos 6 caracteres"),
  phone: z.string().trim().max(30).optional(),
  company: z.string().trim().max(120).optional()
})

export const switchCompanySchema = z.object({
  companyId: z.uuid(),
})

export const loginSchema = z.object({
  email: z.email("Email inválido"),
  password: z.string().min(6, "La contraseña debe de tener al menos 6 caracteres")
})
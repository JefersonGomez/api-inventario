import { z } from "zod"

export const registerSchema = z.object({
  name: z.string().min(1, "El nombre es requerido"),
  email: z.email("Email inválido"),
  password: z.string().min(6, "La contraseña debe de tener al menos 6 caracteres")
})

export const loginSchema = z.object({
  email: z.email("Email inválido"),
  password: z.string().min(6, "La contraseña debe de tener al menos 6 caracteres")
})
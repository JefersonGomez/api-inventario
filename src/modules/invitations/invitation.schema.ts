import { z } from "zod";
import { newPasswordSchema } from "../../shared/password.ts";

export const createInvitationSchema = z.object({
  email: z.email("Email inválido"),
  role: z.enum(["ADMIN", "EMPLOYE"]).default("EMPLOYE"),
});

export const acceptInvitationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), // solo si la cuenta es nueva
  // para cuenta nueva exige la política completa; para una existente es la que ya tiene (se valida contra el hash)
  password: z.string().min(1, "La contraseña es requerida").max(200),
  // obligatoria solo al crear una cuenta nueva (el service lo valida); una cuenta existente ya aceptó
  acceptTerms: z.boolean().optional(),
});

import { z } from "zod";

export const createInvitationSchema = z.object({
  email: z.email("Email inválido"),
  role: z.enum(["ADMIN", "EMPLOYE"]).default("EMPLOYE"),
});

export const acceptInvitationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), // solo si la cuenta es nueva
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

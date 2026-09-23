// src/modules/assistant/assistant.schema.ts
import { z } from "zod";

export const chatMessageSchema = z.object({
  message: z.string().min(1, "El mensaje no puede estar vacío").max(1000, "El mensaje es demasiado largo (máximo 1000 caracteres)"),
});
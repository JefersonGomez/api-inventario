import { z } from "zod";

// Contraseñas que se rechazan aunque cumplan el largo (las primeras de cualquier lista de filtradas)
const COMMON = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password123", "qwerty123",
  "qwertyuiop", "11111111", "00000000", "abc12345", "iloveyou", "admin123", "administrador",
  "contrasena", "contraseña", "contrasena1", "12341234", "87654321", "stockly123", "inventario",
]);

// Para crear o cambiar contraseñas. NO usar en el login: quien ya tiene una de 6 caracteres
// debe poder seguir entrando (se le pide cambiarla desde su perfil).
export const newPasswordSchema = z
  .string()
  .min(8, "La contraseña debe tener al menos 8 caracteres")
  .max(72, "La contraseña es demasiado larga (máximo 72 caracteres)") // bcrypt ignora lo que pase de 72 bytes
  .refine((p) => !COMMON.has(p.toLowerCase()), "Esa contraseña es demasiado común, elige otra");

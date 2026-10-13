// Variables de entorno críticas. Sin valores por defecto: una clave escrita en el código
// firmaría los tokens de cualquier instalación que olvide configurarla.
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error("Falta JWT_SECRET_KEY en el entorno");
  return secret;
}

// Se llama al arrancar el servidor: falla de inmediato y con un mensaje claro, en vez de
// responder 401 a todo más tarde.
export function assertEnv() {
  const secret = jwtSecret();
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL en el entorno");
  if (process.env.NODE_ENV === "production" && secret.length < 32) {
    throw new Error("JWT_SECRET_KEY es demasiado corta para producción (mínimo 32 caracteres)");
  }
}

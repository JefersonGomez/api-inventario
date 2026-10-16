import { ipKeyGenerator, rateLimit } from "express-rate-limit";

// Los tests lo apagan con RATE_LIMIT_OFF=1 (se lee en cada petición para poder encenderlo en uno solo).
const off = () => process.env.RATE_LIMIT_OFF === "1";
const tooMany = { error: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo." };

// Login: solo cuentan los intentos FALLIDOS, por IP + email. Quien entra bien no se penaliza,
// y quien ataca una cuenta no puede bloquear las demás desde la misma red.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: off,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}|${String(req.body?.email ?? "").toLowerCase()}`,
  message: tooMany,
});

// PIN de autorización (4–6 dígitos): solo cuentan los fallos, por persona que pide. Va después de
// Authenticated. 5 fallos cada 15 minutos: probar todos los PIN de 4 dígitos tomaría años.
export const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: off,
  keyGenerator: (req) => `pin|${req.user?.id ?? ipKeyGenerator(req.ip ?? "")}`,
  message: { error: "Demasiados intentos de PIN. Espera unos minutos." },
});

// Registro y aceptar invitaciones (probar contraseñas de cuentas existentes): por IP
export const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: off,
  message: tooMany,
});

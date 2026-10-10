// Orígenes del frontend permitidos (API y socket). CORS_ORIGIN admite varios separados por coma.
export const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

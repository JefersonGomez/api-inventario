import type { NextFunction, Request, Response } from "express";
import multer from "multer";

// Texto que nunca debe llegar al cliente: detalles de Prisma/Postgres (tablas, columnas, consultas)
const INTERNAL = /prisma|PrismaClient|invocation|constraint|relation "|column "|SQLSTATE|ECONNREFUSED|at .*\(.*:\d+:\d+\)/i;

// Red de seguridad: muchos controllers devuelven `error.message` tal cual. Si el texto parece
// interno, se registra en el servidor y el cliente recibe un mensaje genérico.
// ponytail: filtro por patrón; si hace falta más control, tipar los errores de negocio (clase AppError).
export function sanitizeErrors(_req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      const b = body as { error?: unknown; message?: unknown };
      for (const key of ["error", "message"] as const) {
        const value = b[key];
        if (typeof value === "string" && INTERNAL.test(value)) {
          console.error("[error interno]", value);
          b[key] = "Ocurrió un error interno. Intenta de nuevo.";
        }
      }
    }
    return json(body);
  }) as Response["json"];
  next();
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Ruta no encontrada" });
}

// Último middleware: errores que ningún controller capturó (JSON mal formado, subidas, bugs)
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string };

  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "La imagen es demasiado grande (máximo 5 MB)" : "No se pudo procesar el archivo";
    return res.status(400).json({ error: msg });
  }
  if (e.type === "entity.parse.failed") return res.status(400).json({ error: "El cuerpo de la petición no es un JSON válido" });
  if (e.type === "entity.too.large") return res.status(413).json({ error: "La petición es demasiado grande" });

  const status = e.status ?? e.statusCode ?? 500;
  if (status >= 400 && status < 500 && typeof e.message === "string" && !INTERNAL.test(e.message)) {
    return res.status(status).json({ error: e.message });
  }
  console.error("[error no controlado]", err);
  res.status(500).json({ error: "Ocurrió un error interno. Intenta de nuevo." });
}

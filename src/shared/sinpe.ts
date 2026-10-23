import { z } from "zod"

// SINPE Móvil donde la empresa (o cada sucursal) recibe pagos: número de 8 dígitos (se aceptan guiones
// y espacios) y a nombre de quién está, para que el cliente confirme antes de enviar. "" o null = borrar.
export const sinpeFields = {
  sinpeNumber: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^(\d{8})?$/, "El SINPE Móvil es un número de 8 dígitos"))
    .nullable()
    .optional(),
  sinpeName: z.string().trim().max(80).nullable().optional(),
}

import { z } from "zod";
import { checkFiscalId, fiscalIdFields } from "../../shared/fiscal.ts";

const currency = z.enum(["CRC", "USD"]);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

// Datos fiscales del emisor (todos opcionales hasta que la empresa facture). "" o null = borrar.
// Dirección con los códigos de Hacienda: provincia 1–7, cantón y distrito de 2 dígitos.
const fiscalFields = {
  legalName: text(160),
  ...fiscalIdFields,
  economicActivity: z.string().trim().regex(/^[0-9.]{4,10}$/, "Código de actividad económica inválido").nullable().optional().or(z.literal("")),
  invoiceEmail: z.email("Email inválido").nullable().optional().or(z.literal("")),
  phone: text(30),
  province: z.enum(["1", "2", "3", "4", "5", "6", "7"]).nullable().optional().or(z.literal("")),
  canton: z.string().regex(/^\d{2}$/, "El cantón es un código de 2 dígitos").nullable().optional().or(z.literal("")),
  district: z.string().regex(/^\d{2}$/, "El distrito es un código de 2 dígitos").nullable().optional().or(z.literal("")),
  addressDetail: text(250),
};

// al menos un campo: nombre, moneda y datos fiscales se cambian por separado o juntos
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    currency: currency.optional(),
    // días que dura un código de caja; también es lo que queda fijo después de que la persona lo cambia
    cashCodeDays: z.number().int().min(7, "Mínimo 7 días").max(365, "Máximo 365 días").optional(),
    posShowStock: z.boolean().optional(), // el POS muestra la cantidad en stock
    returnDays: z.number().int().min(1, "Mínimo 1 día").max(365, "Máximo 365 días").optional(), // plazo para devolver una venta
    ...fiscalFields,
  })
  .superRefine((d, ctx) => {
    if (Object.values(d).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", message: "Indica al menos un dato de la empresa" });
    }
    checkFiscalId(d, ctx);
  });

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
  currency: currency.optional(),
});

import { z } from "zod";

const currency = z.enum(["CRC", "USD"]);

// al menos un campo: el nombre y la moneda se cambian por separado o juntos
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    currency: currency.optional(),
  })
  .refine((d) => d.name !== undefined || d.currency !== undefined, {
    message: "Indica el nombre o la moneda",
  });

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
  currency: currency.optional(),
});

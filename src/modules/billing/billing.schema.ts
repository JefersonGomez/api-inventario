import { z } from "zod";

export const updateSubscriptionSchema = z
  .object({
    plan: z.enum(["INVOICING", "BASIC", "PRO", "BUSINESS"]).optional(),
    interval: z.enum(["MONTHLY", "ANNUAL"]).optional(),
  })
  .strict()
  .refine((b) => b.plan || b.interval, { message: "Indica el plan o el periodo" });

// el navegador manda solo el id de la tarjeta que registró en ONVO (nunca los datos de la tarjeta);
// sin id se cobra a la tarjeta guardada de la cuenta
export const paySchema = z.object({ paymentMethodId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();

// pagar por SINPE Móvil: quién transfiere (la identificación de la cuenta que manda la plata) y desde qué teléfono
export const paySinpeSchema = z
  .object({
    idType: z.enum(["FISICA", "DIMEX", "JURIDICA"]),
    idNumber: z.string().trim().min(9).max(20),
    phone: z.string().trim().min(8).max(20),
  })
  .strict();

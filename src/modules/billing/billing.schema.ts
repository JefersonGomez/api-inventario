import { z } from "zod";

export const updateSubscriptionSchema = z
  .object({
    plan: z.enum(["INVOICING", "BASIC", "PRO", "BUSINESS"]).optional(),
    interval: z.enum(["MONTHLY", "ANNUAL"]).optional(),
  })
  .strict()
  .refine((b) => b.plan || b.interval, { message: "Indica el plan o el periodo" });

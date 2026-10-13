import { z } from "zod";

export const setPlanSchema = z.object({
  plan: z.enum(["BASIC", "PRO", "BUSINESS"]),
});

export const setSuspendedSchema = z.object({
  suspended: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

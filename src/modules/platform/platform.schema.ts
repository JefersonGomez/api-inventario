import { z } from "zod";

export const setPlanSchema = z.object({
  plan: z.enum(["BASIC", "PRO", "BUSINESS", "INVOICING"]),
});

export const setSuspendedSchema = z.object({
  suspended: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export const aiBudgetSchema = z.object({
  monthlyUsd: z.number().min(0).max(100_000), // 0 = IA apagada
  alertPercent: z.number().int().min(1).max(100),
});
export const aiUsageQuerySchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

// Suscripciones (C5): regalar días y marcar cuenta interna
export const adminSubscriptionSchema = z
  .object({ extendDays: z.number().int().min(1).max(365).optional(), exempt: z.boolean().optional() })
  .strict()
  .refine((b) => b.extendDays !== undefined || b.exempt !== undefined, { message: "Indica los días o si es cuenta interna" });

import { z } from "zod";

export const setPlanSchema = z.object({
  plan: z.enum(["BASIC", "PRO", "BUSINESS"]),
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

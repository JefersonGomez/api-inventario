// Límites de cada plan (null = sin límite). El plan es del dueño de la cuenta (User.plan)
// y aplica a todas sus empresas.
// ponytail: en código hasta que exista el panel de superadmin (Etapa 5); ahí pasa a la base.
import type { PlanCode } from "../generated/prisma/enums.ts";

export type PlanLimits = { maxCompanies: number; maxUsersPerCompany: number | null; maxProducts: number | null };

export const PLANS: Record<PlanCode, PlanLimits> = {
  BASIC: { maxCompanies: 1, maxUsersPerCompany: 3, maxProducts: 200 },
  PRO: { maxCompanies: 3, maxUsersPerCompany: 10, maxProducts: 5000 },
  BUSINESS: { maxCompanies: 10, maxUsersPerCompany: null, maxProducts: null },
};

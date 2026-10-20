// Límites de cada plan (null = sin límite). El plan es del dueño de la cuenta (User.plan) y aplica a
// todas sus empresas; usuarios, sucursales, cajas y productos se cuentan POR EMPRESA (decisión del
// usuario, 16-oct-2026). Las bodegas no tienen límite. Todos los planes tienen todas las funciones,
// salvo la contabilidad (Bloques 10-11), que cambia según el plan.
// ponytail: en código; pasa a la base cuando los planes se editen desde el panel de plataforma.
import type { PlanCode } from "../generated/prisma/enums.ts";

export type PlanLimits = {
  maxCompanies: number;
  maxBranches: number | null;
  maxRegistersPerBranch: number | null; // cajas (Bloque 7)
  maxUsersPerCompany: number | null;
  maxProducts: number | null;
  aiImportsPerMonth: number; // importaciones con ayuda de la IA al mes, por empresa (decisión del 16-oct-2026)
};

export const PLANS: Record<PlanCode, PlanLimits> = {
  BASIC: { maxCompanies: 1, maxBranches: 1, maxRegistersPerBranch: 1, maxUsersPerCompany: 3, maxProducts: 500, aiImportsPerMonth: 5 },
  PRO: { maxCompanies: 2, maxBranches: 3, maxRegistersPerBranch: 3, maxUsersPerCompany: 15, maxProducts: 10_000, aiImportsPerMonth: 30 },
  BUSINESS: { maxCompanies: 5, maxBranches: null, maxRegistersPerBranch: null, maxUsersPerCompany: null, maxProducts: null, aiImportsPerMonth: 100 },
};

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
  aiChatsPerMonth: number; // preguntas al asistente con IA al mes, por empresa (cuida el costo de la IA; 22-nov-2026)
  // "Solo facturación" (facturación como servicio, 18-nov-2026): sin inventario ni cajas; los productos son
  // un catálogo para facturar (facturar no mueve stock) y el menú muestra solo lo de facturar
  invoicingOnly: boolean;
  documentsPerMonth: number | null; // facturas + notas de débito al mes por empresa (las notas de crédito no cuentan)
};

export const PLANS: Record<PlanCode, PlanLimits> = {
  BASIC: { maxCompanies: 1, maxBranches: 1, maxRegistersPerBranch: 1, maxUsersPerCompany: 3, maxProducts: 500, aiImportsPerMonth: 5, aiChatsPerMonth: 150, invoicingOnly: false, documentsPerMonth: null },
  PRO: { maxCompanies: 2, maxBranches: 3, maxRegistersPerBranch: 3, maxUsersPerCompany: 15, maxProducts: 10_000, aiImportsPerMonth: 30, aiChatsPerMonth: 400, invoicingOnly: false, documentsPerMonth: null },
  BUSINESS: { maxCompanies: 5, maxBranches: null, maxRegistersPerBranch: null, maxUsersPerCompany: null, maxProducts: null, aiImportsPerMonth: 100, aiChatsPerMonth: 1000, invoicingOnly: false, documentsPerMonth: null },
  INVOICING: { maxCompanies: 1, maxBranches: 1, maxRegistersPerBranch: 0, maxUsersPerCompany: 2, maxProducts: null, aiImportsPerMonth: 0, aiChatsPerMonth: 30, invoicingOnly: true, documentsPerMonth: 100 },
};

// Precios (colones, IVA incluido; decididos el 22-nov-2026). annual = precio POR MES pagando el año (≈ 2 meses gratis).
// Fuente única: la landing y "Mi suscripción" los leen de GET /plans.
export const PRICES: Record<PlanCode, { monthly: number; annual: number }> = {
  INVOICING: { monthly: 5900, annual: 4900 },
  BASIC: { monthly: 14900, annual: 12400 },
  PRO: { monthly: 29900, annual: 24900 },
  BUSINESS: { monthly: 59900, annual: 49900 },
};

// Prueba gratis y días de gracia después de vencer (decisiones del usuario, 24/25-nov-2026)
export const BILLING = { trialDays: 14, graceDays: 3 } as const;

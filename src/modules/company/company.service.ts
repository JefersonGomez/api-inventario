// company.service.ts — empresa activa y empresas del usuario (datos de plataforma: prismaRoot)
import { prismaRoot } from "../../config/database.ts";
import { PLANS } from "../../config/plans.ts";
import { MODELS } from "../ai/ai.service.ts";
import { MAIN_LOCATION } from "../locations/location.service.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { listUserCompanies } from "../auth/auth.service.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { UpdateCompanyInput } from "./company.schema.ts";

// Empresa activa + plan de su dueño (los límites del plan aplican a la empresa)
export async function getCompany() {
  const company = await prismaRoot.company.findUniqueOrThrow({
    where: { id: currentCompanyId() },
    include: { owner: { select: { plan: true } } },
  });
  const { owner, ...rest } = company;
  const limits = PLANS[owner.plan];
  // lo usado este mes: preguntas al asistente y, si el plan tiene cupo, comprobantes (Configuración y Facturar)
  const [aiChatsThisMonth, documents] = await Promise.all([
    aiChatsThisMonthOf(company.id),
    limits.documentsPerMonth === null ? null : documentsThisMonth(company.id),
  ]);
  const usage = { aiChatsThisMonth, ...(documents !== null && { documentsThisMonth: documents }) };
  return { ...rest, plan: owner.plan, limits, usage };
}

// Facturas, tiquetes y notas de débito emitidos este mes (las notas de crédito corrigen: no gastan cupo)
const QUOTA_TYPES = ["INVOICE", "TICKET", "DEBIT_NOTE"] as const;
function documentsThisMonth(companyId: string) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return prismaRoot.document.count({ where: { companyId, type: { in: [...QUOTA_TYPES] }, issuedAt: { gte: from } } });
}

// Preguntas al asistente este mes: cada pregunta pasa una vez por el filtro (modelo liviano), así que se cuentan esas
function aiChatsThisMonthOf(companyId: string) {
  const now = new Date();
  return prismaRoot.aiUsage.count({
    where: { companyId, feature: "CHAT", model: MODELS.light, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
  });
}

// Antes de preguntarle al asistente: tope mensual del plan
export async function assertAiChatQuota() {
  const { limits, usage } = await getCompany();
  if (usage.aiChatsThisMonth >= limits.aiChatsPerMonth) {
    throw Object.assign(
      new Error(limits.aiChatsPerMonth === 0
        ? "Tu plan no incluye el asistente con IA."
        : `Ya usaste las ${limits.aiChatsPerMonth} preguntas al asistente de este mes que incluye tu plan. El 1.º del próximo mes se renuevan; si necesitas más, mejora tu plan.`),
      { status: 429, code: "AI_CHAT_QUOTA" }
    );
  }
}

// Antes de emitir un comprobante: si el plan tiene cupo mensual y ya se usó, no se emite
export async function assertDocumentQuota() {
  const { limits, usage } = await getCompany();
  if (limits.documentsPerMonth === null || usage.documentsThisMonth === undefined) return;
  if (usage.documentsThisMonth >= limits.documentsPerMonth) {
    throw Object.assign(
      new Error(`Llegaste a los ${limits.documentsPerMonth} comprobantes de este mes que incluye tu plan. El 1.º del próximo mes se renueva; si necesitas más, mejora tu plan.`),
      { status: 409, code: "PLAN_DOCUMENTS" }
    );
  }
}

// Plan "Solo facturación": facturar no mueve stock y no hay cajas
export async function invoicingOnly() {
  return (await getCompany()).limits.invoicingOnly;
}

export async function updateCompany(input: UpdateCompanyInput, userId: string) {
  // solo los campos que vinieron; en los datos fiscales "" se guarda como null (borrar)
  const data = Object.fromEntries(
    Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, k === "name" || k === "currency" || k === "cashCodeDays" || k === "posShowStock" || k === "returnDays" || k === "requirePaymentRef" || k === "cashLimit" ? v : v || null])
  ) as Prisma.CompanyUpdateInput;
  // sin número no hay tipo de identificación
  if ("idNumber" in data && !data.idNumber) data.idType = null;
  const company = await prismaRoot.company.update({ where: { id: currentCompanyId() }, data });
  await logAudit(userId, "UPDATE", "Company", company.id, data as Prisma.InputJsonValue);
  return company;
}

export const listMyCompanies = listUserCompanies;

// Crear otra empresa: el usuario queda como dueño y ADMIN. Límite = maxCompanies de su plan.
export async function createCompany(userId: string, name: string, currency?: "CRC" | "USD") {
  const user = await prismaRoot.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } });
  const owned = await prismaRoot.company.count({ where: { ownerId: userId } });
  const { maxCompanies } = PLANS[user.plan];
  if (owned >= maxCompanies) {
    throw new Error(`Tu plan permite ${maxCompanies} empresa(s). Mejora tu plan para crear más.`);
  }
  return prismaRoot.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name, ownerId: userId, ...(currency && { currency }) } });
    await tx.location.create({ data: MAIN_LOCATION(company.id) });
    await tx.membership.create({ data: { userId, companyId: company.id, role: "ADMIN" } });
    return { id: company.id, name: company.name, role: "ADMIN" as const, isOwner: true };
  });
}

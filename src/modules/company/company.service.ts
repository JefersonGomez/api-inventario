// company.service.ts — empresa activa y empresas del usuario (datos de plataforma: prismaRoot)
import { prismaRoot } from "../../config/database.ts";
import { PLANS } from "../../config/plans.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { listUserCompanies } from "../auth/auth.service.ts";

// Empresa activa + plan de su dueño (los límites del plan aplican a la empresa)
export async function getCompany() {
  const company = await prismaRoot.company.findUniqueOrThrow({
    where: { id: currentCompanyId() },
    include: { owner: { select: { plan: true } } },
  });
  const { owner, ...rest } = company;
  return { ...rest, plan: owner.plan, limits: PLANS[owner.plan] };
}

export async function updateCompany(input: { name?: string; currency?: "CRC" | "USD" }, userId: string) {
  const data = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.currency !== undefined && { currency: input.currency }),
  };
  const company = await prismaRoot.company.update({ where: { id: currentCompanyId() }, data });
  await logAudit(userId, "UPDATE", "Company", company.id, data);
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
    await tx.membership.create({ data: { userId, companyId: company.id, role: "ADMIN" } });
    return { id: company.id, name: company.name, role: "ADMIN" as const, isOwner: true };
  });
}

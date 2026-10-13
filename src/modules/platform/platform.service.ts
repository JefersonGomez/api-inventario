// Panel del dueño de la plataforma: ve todas las empresas (nombre, dueño, plan, uso y estado)
// y puede cambiar el plan o suspenderlas. NO expone datos de inventario de los clientes.
import { prismaRoot } from "../../config/database.ts";
import { PLANS } from "../../config/plans.ts";
import { runWithCompany } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";

export async function listCompanies() {
  const [companies, members, products] = await Promise.all([
    prismaRoot.company.findMany({
      include: { owner: { select: { id: true, name: true, email: true, plan: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prismaRoot.membership.groupBy({ by: ["companyId"], where: { isActive: true }, _count: { _all: true } }),
    prismaRoot.product.groupBy({ by: ["companyId"], where: { deletedAt: null }, _count: { _all: true } }),
  ]);
  const usersBy = new Map(members.map((m) => [m.companyId, m._count._all]));
  const productsBy = new Map(products.map((p) => [p.companyId, p._count._all]));

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    currency: c.currency,
    createdAt: c.createdAt,
    suspendedAt: c.suspendedAt,
    suspensionReason: c.suspensionReason,
    owner: { id: c.owner.id, name: c.owner.name, email: c.owner.email },
    plan: c.owner.plan,
    limits: PLANS[c.owner.plan],
    users: usersBy.get(c.id) ?? 0,
    products: productsBy.get(c.id) ?? 0,
  }));
}

// El plan es de la cuenta del dueño: cambia el de todas sus empresas.
export async function setPlan(companyId: string, plan: "BASIC" | "PRO" | "BUSINESS", byUserId: string) {
  const company = await prismaRoot.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
  if (!company) throw new Error("Empresa no encontrada");
  await prismaRoot.user.update({ where: { id: company.ownerId }, data: { plan } });
  await runWithCompany(companyId, () => logAudit(byUserId, "UPDATE", "Company", companyId, { plan, by: "platform" }));
}

export async function setSuspended(companyId: string, suspended: boolean, reason: string | undefined, byUserId: string) {
  const exists = await prismaRoot.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!exists) throw new Error("Empresa no encontrada");
  await prismaRoot.company.update({
    where: { id: companyId },
    data: suspended
      ? { suspendedAt: new Date(), suspensionReason: reason || null }
      : { suspendedAt: null, suspensionReason: null },
  });
  await runWithCompany(companyId, () =>
    logAudit(byUserId, "UPDATE", "Company", companyId, { suspended, ...(reason && { reason }), by: "platform" })
  );
}

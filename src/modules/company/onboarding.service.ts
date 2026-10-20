// Guía de primeros pasos (Bloque 6B): qué le falta a una empresa nueva para dejar todo listo. Cada paso
// se calcula con los datos reales (no se marca a mano). El administrador puede ocultar la guía.
// Cuando exista el POS (Bloque 7) se suma el paso "abrir la primera caja".
import { prisma, prismaRoot } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"

export async function onboardingStatus() {
  const companyId = currentCompanyId()
  const [company, branch, categories, products, withoutCabys, pending, members, invitations, withPin] = await Promise.all([
    prismaRoot.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { legalName: true, idNumber: true, economicActivity: true, province: true, onboardingDismissedAt: true },
    }),
    prisma.location.findFirst({ where: { type: "BRANCH", isActive: true }, orderBy: { code: "asc" }, select: { address: true } }),
    prisma.category.count({ where: { deletedAt: null } }),
    prisma.product.count({ where: { deletedAt: null } }),
    prisma.product.count({ where: { deletedAt: null, OR: [{ cabys: null }, { cabys: "" }] } }),
    prisma.product.count({ where: { deletedAt: null, pendingReview: true } }),
    prismaRoot.membership.count({ where: { companyId, isActive: true } }),
    prisma.invitation.count({ where: { acceptedAt: null, revokedAt: null } }),
    prismaRoot.membership.count({ where: { companyId, isActive: true, pinHash: { not: null } } }),
  ])

  const steps = [
    // datos con los que se emiten las facturas (Bloque 9): razón social, cédula, actividad y dirección
    { key: "fiscal", link: "/settings?tab=fiscal", done: Boolean(company.legalName && company.idNumber && company.economicActivity && company.province) },
    { key: "branch", link: "/settings?tab=locations", done: Boolean(branch?.address) },
    { key: "categories", link: "/categories", done: categories > 0 },
    { key: "products", link: "/products", done: products > 0 },
    // unidad, IVA y CABYS completos (los pide la factura electrónica); "por completar" = importados sin precio
    { key: "taxes", link: "/products", done: products > 0 && withoutCabys === 0 && pending === 0, meta: { withoutCabys, pending } },
    { key: "team", link: "/users", done: members > 1 || invitations > 0 },
    { key: "cashCodes", link: "/profile?tab=cash", done: withPin > 0 },
  ]
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    dismissed: company.onboardingDismissedAt !== null,
  }
}

export async function setOnboardingDismissed(dismissed: boolean) {
  await prismaRoot.company.update({
    where: { id: currentCompanyId() },
    data: { onboardingDismissedAt: dismissed ? new Date() : null },
  })
  return onboardingStatus()
}

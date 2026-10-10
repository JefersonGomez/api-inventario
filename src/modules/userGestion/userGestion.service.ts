// Usuarios de la empresa activa (vía Membership). Activar/desactivar es por empresa:
// la cuenta sigue funcionando en sus otras empresas.
import { prismaRoot } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";

export async function getAllUsers() {
  const memberships = await prismaRoot.membership.findMany({
    where: { companyId: currentCompanyId() },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } } },
    orderBy: { createdAt: "desc" },
  });
  // misma forma que antes para el frontend: role e isActive salen de la membresía
  return memberships.map((m) => ({ ...m.user, role: m.role, isActive: m.isActive }));
}

export async function toggleUserActive(targetUserId: string, requestingUserId: string) {
  if (targetUserId === requestingUserId) {
    throw new Error("No podés desactivar tu propia cuenta");
  }
  const companyId = currentCompanyId();
  const membership = await prismaRoot.membership.findUnique({
    where: { userId_companyId: { userId: targetUserId, companyId } },
    include: { company: { select: { ownerId: true } } },
  });
  if (!membership) {
    throw new Error("Usuario no encontrado");
  }
  if (membership.company.ownerId === targetUserId) {
    throw new Error("No se puede desactivar al dueño de la empresa");
  }

  const updated = await prismaRoot.membership.update({
    where: { id: membership.id },
    data: { isActive: !membership.isActive },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } } },
  });

  await logAudit(requestingUserId, updated.isActive ? "ACTIVATE" : "DEACTIVATE", "User", targetUserId, {
    previousState: membership.isActive,
    newState: updated.isActive,
  });

  return { ...updated.user, role: updated.role, isActive: updated.isActive };
}

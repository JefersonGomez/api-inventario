// Usuarios de la empresa activa (vía Membership). Activar/desactivar es por empresa:
// la cuenta sigue funcionando en sus otras empresas.
import { prismaRoot } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { assertUserSlot } from "../invitations/invitation.service.ts";
import { catalogResult, contains, type CatalogQuery } from "../../shared/pagination.ts";

// Sin page: todos los miembros. q busca por nombre o correo.
export async function getAllUsers(f: CatalogQuery) {
  const where = {
    companyId: currentCompanyId(),
    ...(f.q && { user: { OR: [{ name: contains(f.q) }, { email: contains(f.q) }] } }),
  };
  // misma forma que antes para el frontend: role e isActive salen de la membresía
  const toUser = (m: { user: object; role: string; isActive: boolean }) => ({ ...m.user, role: m.role, isActive: m.isActive });
  const result = await catalogResult(
    f,
    () => prismaRoot.membership.count({ where }),
    (page) => prismaRoot.membership.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } } },
      orderBy: { createdAt: "desc" },
      ...page,
    })
  );
  return Array.isArray(result) ? result.map(toUser) : { ...result, items: result.items.map(toUser) };
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

  // reactivar ocupa un lugar del plan
  if (!membership.isActive) await assertUserSlot(companyId);

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

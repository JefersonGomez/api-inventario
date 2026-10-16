// Usuarios de la empresa activa (vía Membership). Activar/desactivar es por empresa:
// la cuenta sigue funcionando en sus otras empresas.
import { prismaRoot } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { assertUserSlot } from "../invitations/invitation.service.ts";
import { catalogResult, contains, type CatalogQuery } from "../../shared/pagination.ts";
import { AUTHORIZING_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, effectivePermissions, needsPin, type Permission } from "../../config/permissions.ts";
import type { UpdateAccessInput } from "./userGestion.schema.ts";
import type { Role } from "../../generated/prisma/enums.ts";

// Para la pantalla de Usuarios: qué permisos existen y cuáles trae cada rol
export const permissionCatalog = () => ({
  permissions: PERMISSIONS,
  rolePermissions: ROLE_PERMISSIONS,
  authorizing: AUTHORIZING_PERMISSIONS,
});

// Ids de los miembros activos de la empresa que tienen un permiso (para avisos dirigidos)
export async function memberIdsWith(permission: Permission) {
  const members = await prismaRoot.membership.findMany({
    where: { companyId: currentCompanyId(), isActive: true, user: { isActive: true } },
    select: { userId: true, role: true, grantedPermissions: true, revokedPermissions: true },
  });
  return members
    .filter((m) => effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions).includes(permission))
    .map((m) => m.userId);
}

// Sin page: todos los miembros. q busca por nombre o correo.
export async function getAllUsers(f: CatalogQuery) {
  const where = {
    companyId: currentCompanyId(),
    ...(f.q && { user: { OR: [{ name: contains(f.q) }, { email: contains(f.q) }] } }),
  };
  // misma forma que antes para el frontend: role e isActive salen de la membresía
  const toUser = (m: { user: object; role: Role; isActive: boolean; grantedPermissions: string[]; revokedPermissions: string[]; pinHash: string | null; locationIds: string[] }) => ({
    ...m.user,
    role: m.role,
    isActive: m.isActive,
    grantedPermissions: m.grantedPermissions,
    revokedPermissions: m.revokedPermissions,
    hasPin: m.pinHash !== null, // el PIN en sí nunca sale del servidor
    locationIds: m.locationIds,
    needsPin: needsPin(effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions)),
  });
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

// Cambiar el rol y los ajustes de una persona. Nadie cambia su propio acceso, y el dueño de la
// empresa siempre es Administrador (así la empresa nunca queda sin quien la administre).
export async function updateUserAccess(targetUserId: string, input: UpdateAccessInput, requestingUserId: string) {
  if (targetUserId === requestingUserId) throw new Error("No podés cambiar tu propio acceso");
  const companyId = currentCompanyId();
  const membership = await prismaRoot.membership.findUnique({
    where: { userId_companyId: { userId: targetUserId, companyId } },
    include: { company: { select: { ownerId: true } } },
  });
  if (!membership) throw new Error("Usuario no encontrado");
  if (membership.company.ownerId === targetUserId && input.role !== "ADMIN") {
    throw new Error("El dueño de la empresa siempre es Administrador");
  }
  // al Administrador no se le ajusta nada (tiene todo); en los demás, solo se guarda lo que difiere del rol
  const base = ROLE_PERMISSIONS[input.role];
  const granted = input.role === "ADMIN" ? [] : input.grantedPermissions.filter((p) => !base.includes(p));
  const revoked = input.role === "ADMIN" ? [] : input.revokedPermissions.filter((p) => base.includes(p));
  // si ya no abre caja ni autoriza, su código no sirve: se borra
  const keepsPin = needsPin(effectivePermissions(input.role, granted, revoked));
  // ubicaciones: solo de esta empresa y activas; el administrador trabaja en todas
  const locationIds = input.role === "ADMIN" ? [] : [...new Set(input.locationIds)];
  if (locationIds.length) {
    const found = await prismaRoot.location.count({ where: { companyId, id: { in: locationIds }, isActive: true } });
    if (found !== locationIds.length) throw new Error("Alguna ubicación no existe o está desactivada");
  }

  const updated = await prismaRoot.membership.update({
    where: { id: membership.id },
    data: { role: input.role, grantedPermissions: granted, revokedPermissions: revoked, locationIds, ...(!keepsPin && { pinHash: null, pinSetAt: null, pinSetBySelf: false }) },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true } } },
  });
  await logAudit(requestingUserId, "UPDATE", "UserAccess", targetUserId, {
    before: { role: membership.role, granted: membership.grantedPermissions, revoked: membership.revokedPermissions, locationIds: membership.locationIds },
    after: { role: input.role, granted, revoked, locationIds },
  });
  return {
    ...updated.user,
    role: updated.role,
    isActive: updated.isActive,
    grantedPermissions: updated.grantedPermissions,
    revokedPermissions: updated.revokedPermissions,
    hasPin: updated.pinHash !== null,
    needsPin: keepsPin,
    locationIds: updated.locationIds,
  };
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

// PIN de autorización (Bloque 3): el encargado autoriza en la pantalla del cajero, sin que este
// cierre su sesión (descuento grande, anular una venta). El PIN es por empresa (vive en la
// membresía), se guarda con bcrypt y nunca sale del servidor.
import bcrypt from "bcrypt"
import { z } from "zod"
import { prismaRoot } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { AUTHORIZING_PERMISSIONS, effectivePermissions } from "../../config/permissions.ts"
import { logAudit } from "../audit/audit.service.ts"

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "El PIN tiene de 4 a 6 dígitos"),
  password: z.string().min(1, "Confirma con tu contraseña"),
})

export const authorizeSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "El PIN tiene de 4 a 6 dígitos"),
  permission: z.enum(AUTHORIZING_PERMISSIONS as ["sales.discount", "sales.void"]),
  reason: z.string().trim().max(200).optional(), // qué se autoriza (queda en auditoría)
})

async function myMembership(userId: string) {
  return prismaRoot.membership.findUniqueOrThrow({
    where: { userId_companyId: { userId, companyId: currentCompanyId() } },
    include: { user: { select: { passwordHash: true } } },
  })
}

// Guardar o cambiar el propio PIN: solo quien puede autorizar, y confirmando con su contraseña
export async function setMyPin(userId: string, pin: string, password: string) {
  const m = await myMembership(userId)
  const perms = effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions)
  if (!perms.some((p) => AUTHORIZING_PERMISSIONS.includes(p))) {
    throw new Error("Tu rol no autoriza descuentos ni anulaciones: no necesitas PIN")
  }
  if (!(await bcrypt.compare(password, m.user.passwordHash))) throw new Error("La contraseña no es correcta")
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    throw new Error("Elige un PIN menos obvio (nada de 1234 ni 0000)")
  }
  await prismaRoot.membership.update({ where: { id: m.id }, data: { pinHash: await bcrypt.hash(pin, 10) } })
  await logAudit(userId, "UPDATE", "AuthorizationPin", userId)
}

export async function deleteMyPin(userId: string) {
  const m = await myMembership(userId)
  await prismaRoot.membership.update({ where: { id: m.id }, data: { pinHash: null } })
  await logAudit(userId, "DELETE", "AuthorizationPin", userId)
}

export async function hasPin(userId: string) {
  return (await myMembership(userId)).pinHash !== null
}

// ¿Este PIN es de alguien de la empresa que puede dar ese permiso? Devuelve quién autorizó.
// Se compara contra los miembros activos con el permiso y PIN (pocos por empresa).
export async function authorizeWithPin(requesterId: string, pin: string, permission: string, reason?: string) {
  const candidates = await prismaRoot.membership.findMany({
    where: { companyId: currentCompanyId(), isActive: true, pinHash: { not: null }, user: { isActive: true } },
    include: { user: { select: { id: true, name: true } } },
  })
  for (const m of candidates) {
    if (!effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions).includes(permission as never)) continue
    if (await bcrypt.compare(pin, m.pinHash!)) {
      await logAudit(m.user.id, "AUTHORIZE", "Authorization", requesterId, { permission, requestedBy: requesterId, ...(reason && { reason }) })
      return { authorizedBy: { id: m.user.id, name: m.user.name }, permission }
    }
  }
  return null
}

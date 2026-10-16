// Código de caja (Bloque 3): con él se abre caja (Bloque 7) y, quien tiene permiso, autoriza en la
// pantalla del cajero sin que este cierre su sesión (descuentos, anulaciones, notas de crédito).
// Es por empresa (vive en la membresía), se guarda con bcrypt y nunca sale del servidor, salvo
// al generarlo: se muestra una sola vez para entregárselo a la persona.
// Reglas (decisión del usuario): lo genera el administrador, o el encargado para los cajeros; la
// persona puede cambiarlo, y después queda fijo PIN_LOCK_DAYS días. Si lo olvida, el admin genera otro.
import bcrypt from "bcrypt"
import { randomInt } from "node:crypto"
import { z } from "zod"
import { prismaRoot } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { AUTHORIZING_PERMISSIONS, canAuthorize, effectivePermissions, needsPin } from "../../config/permissions.ts"
import { logAudit } from "../audit/audit.service.ts"

export const PIN_LOCK_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "El código tiene de 4 a 6 dígitos"),
  password: z.string().min(1, "Confirma con tu contraseña"),
})

export const authorizeSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "El PIN tiene de 4 a 6 dígitos"),
  permission: z.enum(AUTHORIZING_PERMISSIONS as ["sales.discount", "sales.void"]),
  reason: z.string().trim().max(200).optional(), // qué se autoriza (queda en auditoría)
})

const isObvious = (pin: string) => /^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)

async function membershipOf(userId: string) {
  const m = await prismaRoot.membership.findUnique({
    where: { userId_companyId: { userId, companyId: currentCompanyId() } },
    include: { user: { select: { passwordHash: true } } },
  })
  if (!m) throw new Error("Usuario no encontrado")
  return { ...m, perms: effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions) }
}

// Desde cuándo puede la persona cambiar su código (null = ya puede, o no tiene)
const lockedUntil = (m: { pinHash: string | null; pinSetBySelf: boolean; pinSetAt: Date | null }) =>
  m.pinHash && m.pinSetBySelf && m.pinSetAt && m.pinSetAt.getTime() + PIN_LOCK_DAYS * DAY > Date.now()
    ? new Date(m.pinSetAt.getTime() + PIN_LOCK_DAYS * DAY)
    : null

// Para /auth/me y el perfil
export async function pinStatus(userId: string) {
  const m = await membershipOf(userId)
  return { hasPin: m.pinHash !== null, pinLockedUntil: lockedUntil(m) }
}

// Generar (o regenerar, si lo olvidó) el código de otra persona. El administrador, para cualquiera
// que lo necesite; el encargado (quien autoriza), solo para quien no autoriza (cajeros).
export async function generatePinFor(targetUserId: string, requester: { id: string; permissions: string[] }) {
  const target = await membershipOf(targetUserId)
  if (!needsPin(target.perms)) throw new Error("Esta persona no abre caja ni autoriza: no necesita código")
  const isAdmin = requester.permissions.includes("users.manage")
  if (!isAdmin && (!canAuthorize(requester.permissions) || canAuthorize(target.perms) || targetUserId === requester.id)) {
    throw Object.assign(new Error("Solo el administrador puede generar este código"), { status: 403 })
  }
  let pin: string
  do pin = String(randomInt(0, 1_000_000)).padStart(6, "0")
  while (isObvious(pin))
  await prismaRoot.membership.update({
    where: { id: target.id },
    data: { pinHash: await bcrypt.hash(pin, 10), pinSetAt: new Date(), pinSetBySelf: false },
  })
  await logAudit(requester.id, "UPDATE", "AuthorizationPin", targetUserId, { generated: true })
  return { pin } // única vez que sale: se entrega a la persona
}

// Cambiar el propio código, confirmando con la contraseña. Hace falta que alguien lo haya generado
// antes (salvo el administrador, que se lo pone él mismo) y que no esté en el plazo de bloqueo.
export async function setMyPin(userId: string, pin: string, password: string) {
  const m = await membershipOf(userId)
  if (!needsPin(m.perms)) throw new Error("Tu rol no abre caja ni autoriza: no necesitas código")
  if (!m.pinHash && !m.perms.includes("users.manage")) throw new Error("Pide tu código al administrador")
  const until = lockedUntil(m)
  if (until) throw new Error(`Ya cambiaste tu código: podrás cambiarlo de nuevo a partir del ${until.toLocaleDateString("es-CR")}. Si lo olvidaste, pide uno nuevo al administrador`)
  if (!(await bcrypt.compare(password, m.user.passwordHash))) throw new Error("La contraseña no es correcta")
  if (isObvious(pin)) throw new Error("Elige un código menos obvio (nada de 1234 ni 0000)")
  await prismaRoot.membership.update({
    where: { id: m.id },
    data: { pinHash: await bcrypt.hash(pin, 10), pinSetAt: new Date(), pinSetBySelf: true },
  })
  await logAudit(userId, "UPDATE", "AuthorizationPin", userId)
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

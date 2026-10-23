// Código de caja (Bloque 3): con él se abre caja (Bloque 7) y, quien tiene permiso, autoriza en la
// pantalla del cajero sin que este cierre su sesión (descuentos, anulaciones, notas de crédito).
// Es por empresa (vive en la membresía), se guarda con bcrypt y nunca sale del servidor, salvo
// al asignarlo: se muestra una sola vez para entregárselo a la persona.
// Reglas (decisión del usuario): lo asigna el administrador, o el encargado para los cajeros (elegido o
// al azar); la persona puede cambiarlo, y después queda fijo hasta que vence. Vence a los
// Company.cashCodeDays días (30 por defecto): vencido no sirve hasta que se renueve.
import bcrypt from "bcrypt"
import { randomInt } from "node:crypto"
import { z } from "zod"
import { prisma, prismaRoot } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { AUTHORIZING_PERMISSIONS, canAuthorize, effectivePermissions, needsPin } from "../../config/permissions.ts"
import { logAudit } from "../audit/audit.service.ts"
import { createNotifications } from "../notifications/notifications.persist.ts"
import { assertNotDemoUser } from "../demo/demo-guard.ts"

export const PIN_WARN_DAYS = 5 // aviso de "por vencer"
const DAY = 24 * 60 * 60 * 1000
const pinField = z.string().regex(/^\d{4,6}$/, "El código tiene de 4 a 6 dígitos")

export const setPinSchema = z.object({ pin: pinField, password: z.string().min(1, "Confirma con tu contraseña") })
// sin pin: se genera uno al azar
export const assignPinSchema = z.object({ pin: pinField.optional() }).optional() // sin cuerpo = al azar

export const authorizeSchema = z.object({
  pin: pinField,
  permission: z.enum(AUTHORIZING_PERMISSIONS as ["sales.discount", "sales.void", "sales.negative", "sales.credit"]),
  reason: z.string().trim().max(200).optional(), // qué se autoriza (queda en auditoría)
})

const isObvious = (pin: string) => /^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)

const codeDays = async () =>
  (await prismaRoot.company.findUniqueOrThrow({ where: { id: currentCompanyId() }, select: { cashCodeDays: true } })).cashCodeDays

type CodeFields = { pinHash: string | null; pinSetAt: Date | null; pinSetBySelf: boolean }

// Vencimiento y bloqueo de un código. Sin fecha (códigos anteriores a esta regla) cuenta como vencido.
function codeInfo(m: CodeFields, days: number) {
  if (!m.pinHash) return { hasPin: false, pinExpiresAt: null, pinExpired: false, pinExpiringSoon: false, pinLockedUntil: null }
  const expiresAt = m.pinSetAt ? new Date(m.pinSetAt.getTime() + days * DAY) : new Date(0)
  const expired = expiresAt.getTime() <= Date.now()
  return {
    hasPin: true,
    pinExpiresAt: expiresAt,
    pinExpired: expired,
    pinExpiringSoon: !expired && expiresAt.getTime() - Date.now() <= PIN_WARN_DAYS * DAY,
    // después de cambiarlo, la persona no puede volver a cambiarlo hasta que venza
    pinLockedUntil: m.pinSetBySelf && !expired ? expiresAt : null,
  }
}

async function membershipOf(userId: string) {
  const m = await prismaRoot.membership.findUnique({
    where: { userId_companyId: { userId, companyId: currentCompanyId() } },
    include: { user: { select: { name: true, passwordHash: true } } },
  })
  if (!m) throw new Error("Usuario no encontrado")
  return { ...m, perms: effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions) }
}

// Para /auth/me, el perfil y los avisos
export async function pinStatus(userId: string) {
  return codeInfo(await membershipOf(userId), await codeDays())
}

// ¿Puede quien pide manejar el código de esa persona? El admin, el de cualquiera; quien autoriza
// (encargado), solo el de quien no autoriza (cajeros). Nunca el propio por esta vía.
const canManageCodeOf = (requester: { id: string; permissions: string[] }, target: { userId: string; perms: string[] }) =>
  target.userId !== requester.id &&
  needsPin(target.perms) &&
  (requester.permissions.includes("users.manage") || (canAuthorize(requester.permissions) && !canAuthorize(target.perms)))

const forbidden = (message: string) => Object.assign(new Error(message), { status: 403 })

// Personas cuyo código puede asignar quien pide, con el estado de su código (pantalla "Códigos del equipo")
export async function cashCodeTeam(requester: { id: string; permissions: string[] }) {
  if (!requester.permissions.includes("users.manage") && !canAuthorize(requester.permissions)) {
    throw forbidden("No puedes asignar códigos de caja")
  }
  const [members, days] = await Promise.all([
    prismaRoot.membership.findMany({
      where: { companyId: currentCompanyId(), isActive: true, user: { isActive: true } },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    codeDays(),
  ])
  return members
    .map((m) => ({ m, perms: effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions) }))
    .filter(({ m, perms }) => canManageCodeOf(requester, { userId: m.userId, perms }))
    .map(({ m }) => ({ id: m.user.id, name: m.user.name, role: m.role, ...codeInfo(m, days) }))
}

// Asignar (o renovar, si lo olvidó o venció) el código de otra persona: el elegido o uno al azar.
// Le llega un aviso; el código solo se devuelve acá, para entregárselo.
export async function assignPinTo(targetUserId: string, requester: { id: string; permissions: string[] }, chosen?: string) {
  await assertNotDemoUser(targetUserId) // los códigos de la demo se muestran en pantalla: no se cambian
  const target = await membershipOf(targetUserId)
  if (!needsPin(target.perms)) throw new Error("Esta persona no abre caja ni autoriza: no necesita código")
  if (!canManageCodeOf(requester, { userId: targetUserId, perms: target.perms })) {
    throw forbidden("Solo el administrador puede asignar este código")
  }
  if (chosen && isObvious(chosen)) throw new Error("Elige un código menos obvio (nada de 1234 ni 0000)")
  let pin = chosen
  while (!pin || isObvious(pin)) pin = String(randomInt(0, 1_000_000)).padStart(6, "0")

  const by = await membershipOf(requester.id)
  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: target.id },
      data: { pinHash: await bcrypt.hash(pin, 10), pinSetAt: new Date(), pinSetBySelf: false },
    })
    await createNotifications(
      [{ userId: targetUserId, type: "cashCodeAssigned", title: "", link: "/profile?tab=cash", meta: { by: by.user.name } }],
      tx
    )
    await logAudit(requester.id, "UPDATE", "AuthorizationPin", targetUserId, { assigned: true, random: !chosen }, tx)
  })
  return { pin } // única vez que sale: se entrega a la persona
}

// Cambiar el propio código, confirmando con la contraseña. Hace falta que alguien lo haya asignado
// antes (salvo el administrador, que se pone el suyo) y que no esté fijo (lo cambió y no ha vencido).
export async function setMyPin(userId: string, pin: string, password: string) {
  const m = await membershipOf(userId)
  if (!needsPin(m.perms)) throw new Error("Tu rol no abre caja ni autoriza: no necesitas código")
  if (!m.pinHash && !m.perms.includes("users.manage")) throw new Error("Pide tu código al administrador")
  const { pinLockedUntil } = codeInfo(m, await codeDays())
  if (pinLockedUntil) {
    throw new Error(`Ya cambiaste tu código: podrás cambiarlo de nuevo cuando venza, el ${pinLockedUntil.toLocaleDateString("es-CR")}. Si lo olvidaste, pide uno nuevo al administrador`)
  }
  if (!(await bcrypt.compare(password, m.user.passwordHash))) throw new Error("La contraseña no es correcta")
  if (isObvious(pin)) throw new Error("Elige un código menos obvio (nada de 1234 ni 0000)")
  await prismaRoot.membership.update({
    where: { id: m.id },
    data: { pinHash: await bcrypt.hash(pin, 10), pinSetAt: new Date(), pinSetBySelf: true },
  })
  await logAudit(userId, "UPDATE", "AuthorizationPin", userId)
}

// ¿Este PIN es de alguien de la empresa que puede dar ese permiso? Devuelve quién autorizó.
// Se compara contra los miembros activos con el permiso y un código vigente (pocos por empresa).
export async function authorizeWithPin(requesterId: string, pin: string, permission: string, reason?: string) {
  const [candidates, days] = await Promise.all([
    prismaRoot.membership.findMany({
      where: { companyId: currentCompanyId(), isActive: true, pinHash: { not: null }, user: { isActive: true } },
      include: { user: { select: { id: true, name: true } } },
    }),
    codeDays(),
  ])
  for (const m of candidates) {
    if (!effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions).includes(permission as never)) continue
    if (codeInfo(m, days).pinExpired) continue // vencido: no sirve hasta que se renueve
    if (await bcrypt.compare(pin, m.pinHash!)) {
      await logAudit(m.user.id, "AUTHORIZE", "Authorization", requesterId, { permission, requestedBy: requesterId, ...(reason && { reason }) })
      return { authorizedBy: { id: m.user.id, name: m.user.name }, permission }
    }
  }
  return null
}

export class CodeExpiredError extends Error {}

// Abrir caja (Bloque 7): el código tiene que ser el de la persona, vigente. Vencido = caja bloqueada
// hasta renovarlo (ella misma desde su perfil o con el código del encargado, renewWithManagerPin).
export async function verifyOwnPin(userId: string, pin: string) {
  const m = await membershipOf(userId)
  if (!m.pinHash) throw new Error("Todavía no tienes código de caja: pídeselo al administrador")
  const info = codeInfo(m, await codeDays())
  if (info.pinExpired) throw new CodeExpiredError("Tu código de caja venció: no puedes abrir caja hasta renovarlo")
  if (!(await bcrypt.compare(pin, m.pinHash))) throw new Error("El código no es correcto")
  return info
}

// El encargado (o el admin) renueva en la misma pantalla el código vencido de un cajero con SU código:
// se genera uno nuevo al azar para el cajero (se muestra una vez). null = el código no sirve para esto.
export async function renewWithManagerPin(cashierId: string, managerPin: string) {
  const [candidates, days] = await Promise.all([
    prismaRoot.membership.findMany({
      where: { companyId: currentCompanyId(), isActive: true, pinHash: { not: null }, user: { isActive: true } },
      select: { userId: true, role: true, grantedPermissions: true, revokedPermissions: true, pinHash: true, pinSetAt: true, pinSetBySelf: true },
    }),
    codeDays(),
  ])
  const target = await membershipOf(cashierId)
  for (const m of candidates) {
    if (m.userId === cashierId || codeInfo(m, days).pinExpired) continue
    const permissions = effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions)
    if (!canManageCodeOf({ id: m.userId, permissions }, { userId: cashierId, perms: target.perms })) continue
    if (await bcrypt.compare(managerPin, m.pinHash!)) return assignPinTo(cashierId, { id: m.userId, permissions })
  }
  return null
}

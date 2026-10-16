// invitation.service.ts — el admin invita por email; quien recibe el link crea su cuenta
// (o entra con la que ya tiene) y queda como miembro de la empresa.
// Crear/listar/anular corre en la empresa activa (prisma filtrado); ver y aceptar un link
// es público, así que usa prismaRoot y busca la invitación por el hash del token.
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma, prismaRoot } from "../../config/database.ts";
import { PLANS } from "../../config/plans.ts";
import { currentCompanyId, runWithCompany } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { createNotifications } from "../notifications/notifications.persist.ts";
import { openSession } from "../auth/auth.service.ts";
import type { Role } from "../../generated/prisma/enums.ts";
import { newPasswordSchema } from "../../shared/password.ts";
import { TERMS_VERSION, TERMS_REQUIRED_MESSAGE } from "../../config/legal.ts";

const EXPIRY_DAYS = 7;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const appUrl = () => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const pendingWhere = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

// Usuarios activos + invitaciones pendientes no pueden pasar el límite del plan del dueño
export async function assertUserSlot(companyId: string, extra = 1) {
  const company = await prismaRoot.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { owner: { select: { plan: true } } },
  });
  const max = PLANS[company.owner.plan].maxUsersPerCompany;
  if (max === null) return;
  const [members, pending] = await Promise.all([
    prismaRoot.membership.count({ where: { companyId, isActive: true } }),
    prismaRoot.invitation.count({ where: { companyId, ...pendingWhere() } }),
  ]);
  if (members + pending + extra > max) {
    throw new Error(`Tu plan permite ${max} usuarios por empresa (contando invitaciones pendientes). Mejora tu plan para agregar más.`);
  }
}

// Crea (o renueva) la invitación de un email. El token solo se devuelve acá: después no se puede recuperar.
export async function createInvitation(email: string, role: Role, invitedById: string) {
  const companyId = currentCompanyId();
  email = email.trim().toLowerCase();

  const existingMember = await prismaRoot.membership.findFirst({
    where: { companyId, isActive: true, user: { email: { equals: email, mode: "insensitive" } } },
  });
  if (existingMember) throw new Error("Esa persona ya es parte de la empresa");

  // renovar: la invitación pendiente anterior de ese email queda anulada (y libera su lugar)
  await prisma.invitation.updateMany({ where: { email, ...pendingWhere() }, data: { revokedAt: new Date() } });
  await assertUserSlot(companyId);

  const token = crypto.randomBytes(32).toString("hex");
  const invitation = await prisma.invitation.create({
    data: {
      companyId,
      email,
      role,
      invitedById,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  await logAudit(invitedById, "CREATE", "Invitation", invitation.id, { email, role });
  return { invitation, link: `${appUrl()}/invite/${token}` };
}

export function listPendingInvitations() {
  return prisma.invitation.findMany({
    where: pendingWhere(),
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true, invitedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvitation(id: string, userId: string) {
  const { count } = await prisma.invitation.updateMany({
    where: { id, ...pendingWhere() },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw new Error("Invitación no encontrada o ya usada");
  await logAudit(userId, "DELETE", "Invitation", id);
}

async function findByToken(token: string) {
  return prismaRoot.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { company: { select: { id: true, name: true } }, invitedBy: { select: { name: true } } },
  });
}

const statusOf = (inv: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) =>
  inv.acceptedAt ? "accepted" : inv.revokedAt ? "revoked" : inv.expiresAt <= new Date() ? "expired" : "valid";

// Lo que ve quien abre el link (sin iniciar sesión)
export async function getInvitationByToken(token: string) {
  const inv = await findByToken(token);
  if (!inv) return null;
  const userExists = (await prismaRoot.user.count({ where: { email: { equals: inv.email, mode: "insensitive" } } })) > 0;
  return {
    status: statusOf(inv),
    email: inv.email,
    role: inv.role,
    company: inv.company.name,
    invitedBy: inv.invitedBy.name,
    expiresAt: inv.expiresAt,
    userExists,
  };
}

// Aceptar: cuenta nueva (name + password) o existente (su password). Devuelve la sesión ya abierta en la empresa.
export async function acceptInvitation(token: string, input: { name?: string; password: string; acceptTerms?: boolean }) {
  const inv = await findByToken(token);
  if (!inv) throw new Error("Invitación no encontrada");
  const status = statusOf(inv);
  if (status !== "valid") {
    throw new Error(status === "expired" ? "La invitación venció. Pide una nueva." : "Esta invitación ya no es válida");
  }

  let user = await prismaRoot.user.findFirst({ where: { email: { equals: inv.email, mode: "insensitive" } } });
  if (user) {
    if (!(await bcrypt.compare(input.password, user.passwordHash))) throw new Error("Contraseña incorrecta");
    if (!user.isActive) throw new Error("Tu cuenta está desactivada");
  } else {
    if (!input.name?.trim()) throw new Error("Indica tu nombre");
    if (input.acceptTerms !== true) throw new Error(TERMS_REQUIRED_MESSAGE);
    const policy = newPasswordSchema.safeParse(input.password);
    if (!policy.success) throw new Error(policy.error.issues[0]!.message);
    user = await prismaRoot.user.create({
      data: {
        name: input.name.trim(),
        email: inv.email,
        passwordHash: await bcrypt.hash(input.password, 10),
        termsAcceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
      },
    });
  }
  const userId = user.id;

  await prismaRoot.$transaction(async (tx) => {
    // si ya había sido miembro (desactivado), la invitación lo vuelve a activar con el rol nuevo
    await tx.membership.upsert({
      where: { userId_companyId: { userId, companyId: inv.companyId } },
      create: { userId, companyId: inv.companyId, role: inv.role },
      update: { role: inv.role, isActive: true },
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
  });

  await runWithCompany(inv.companyId, async () => {
    await logAudit(userId, "CREATE", "Membership", userId, { via: "invitation", role: inv.role });
    if (inv.invitedById !== userId) {
      await createNotifications([{
        userId: inv.invitedById,
        type: "memberJoined",
        title: user.name,
        meta: { company: inv.company.name },
        link: "/users",
      }]);
    }
  });

  return openSession(userId, inv.companyId, true);
}

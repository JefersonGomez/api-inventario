// Auth multi-empresa: el token lleva { id, companyId }; el rol sale de la membresía.
// Usa prismaRoot: usuarios, empresas, membresías y refresh tokens son datos de plataforma.
import { prismaRoot as prisma } from "../../config/database.ts";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import crypto from "crypto";
import { jwtSecret } from "../../config/env.ts";
import { TERMS_VERSION } from "../../config/legal.ts";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

const userPublic = { id: true, name: true, email: true, avatarUrl: true, phone: true, company: true } as const;

// Registro = crear cuenta + su primera empresa, de la que es ADMIN y dueño.
// Los empleados no se registran solos: los agrega el admin de cada empresa.
export async function Register(
  name: string,
  email: string,
  password: string,
  extra: { phone?: string; company?: string } = {}
) {
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new Error("El usuario ya existe");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const companyName = extra.company?.trim() || `Empresa de ${name}`;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash,
        termsAcceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
        ...(extra.phone && { phone: extra.phone }),
        ...(extra.company && { company: extra.company }),
      },
      select: userPublic,
    });
    const company = await tx.company.create({ data: { name: companyName, ownerId: user.id } });
    await tx.membership.create({ data: { userId: user.id, companyId: company.id, role: "ADMIN" } });
    await tx.user.update({ where: { id: user.id }, data: { lastCompanyId: company.id } });
    return { ...user, role: "ADMIN" as const, companyId: company.id };
  });
}

function signAccessToken(userId: string, companyId: string) {
  const opciones: SignOptions = { expiresIn: ACCESS_TOKEN_EXPIRY };
  return jwt.sign({ id: userId, companyId }, jwtSecret(), opciones);
}

// Refresh token persistido: "id.secret"; el id ubica la fila, el secret la valida
async function createRefreshToken(userId: string, companyId: string) {
  const secret = crypto.randomBytes(40).toString("hex");
  const tokenHash = await bcrypt.hash(secret, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const record = await prisma.refreshToken.create({ data: { userId, companyId, tokenHash, expiresAt } });
  return `${record.id}.${secret}`;
}

// Empresas en las que el usuario está activo
export function listUserCompanies(userId: string) {
  return prisma.membership
    .findMany({
      where: { userId, isActive: true },
      include: { company: { select: { id: true, name: true, ownerId: true } } },
      orderBy: { createdAt: "asc" },
    })
    .then((ms) => ms.map((m) => ({ id: m.company.id, name: m.company.name, role: m.role, isOwner: m.company.ownerId === userId })));
}

// Arma la sesión de un usuario en una empresa. `preferred` = la pedida (o la última usada);
// si no tiene acceso a esa, abre la primera empresa activa.
export async function openSession(userId: string, preferred: string | null, strict = false) {
  const companies = await listUserCompanies(userId);
  if (companies.length === 0) {
    throw new Error("No tienes acceso a ninguna empresa activa. Contacta a un administrador.");
  }
  let active = companies.find((c) => c.id === preferred);
  if (!active) {
    if (strict) throw new Error("No tienes acceso a esa empresa");
    active = companies[0]!;
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: { lastCompanyId: active.id },
    select: userPublic,
  });
  return {
    token: signAccessToken(userId, active.id),
    refreshToken: await createRefreshToken(userId, active.id),
    user: { ...user, role: active.role },
    company: active,
    companies,
  };
}

export async function Login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new Error("Credenciales invalidas");
  }
  if (!user.isActive) {
    throw new Error("Tu cuenta ha sido desactivada. Contacta a un administrador.");
  }
  return openSession(user.id, user.lastCompanyId);
}

// Cambiar de empresa: nueva sesión (tokens nuevos) en otra empresa a la que pertenece
export async function switchCompany(userId: string, companyId: string) {
  return openSession(userId, companyId, true);
}

export async function refreshAccessToken(refreshTokenString: string) {
  const [id, secret] = refreshTokenString.split(".");
  if (!id || !secret) {
    throw new Error("Refresh token inválido");
  }

  const record = await prisma.refreshToken.findUnique({ where: { id } });
  if (!record || record.revoked || record.expiresAt < new Date()) {
    throw new Error("Refresh token inválido o expirado");
  }
  if (!(await bcrypt.compare(secret, record.tokenHash))) {
    throw new Error("Refresh token inválido");
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || !user.isActive) {
    throw new Error("Usuario no encontrado o inactivo");
  }

  // la sesión sigue en su empresa (si perdió el acceso, debe volver a iniciar sesión)
  const companyId = record.companyId ?? user.lastCompanyId;
  const membership = companyId
    ? await prisma.membership.findUnique({ where: { userId_companyId: { userId: user.id, companyId } } })
    : null;
  if (!companyId || !membership?.isActive) {
    throw new Error("Ya no tienes acceso a esta empresa");
  }

  // Rotación: cada refresh token sirve una sola vez
  await prisma.refreshToken.update({ where: { id }, data: { revoked: true } });

  return {
    token: signAccessToken(user.id, companyId),
    refreshToken: await createRefreshToken(user.id, companyId),
  };
}

export async function logout(refreshTokenString: string) {
  const [id] = refreshTokenString.split(".");
  if (!id) return;
  await prisma.refreshToken.updateMany({ where: { id, revoked: false }, data: { revoked: true } });
}

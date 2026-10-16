import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prismaRoot } from "../config/database.ts";
import { runWithCompany } from "../shared/tenant.ts";
import { jwtSecret } from "../config/env.ts";
import { effectivePermissions, type Permission } from "../config/permissions.ts";

// Rutas que siguen disponibles con la empresa suspendida
const SUSPENDED_ALLOWED = new Set([
  "GET /auth/me",
  "POST /auth/switch-company",
  "GET /companies",
  "GET /company",
  "GET /profile/me",
]);

// Token = { id, companyId }. El rol y si sigue activo se leen de la membresía en cada
// petición: quitar a alguien de una empresa o cambiarle el rol aplica al instante.
export async function Authenticated(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ message: "acceso no autorizado" });
    }
    const token = header.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Formato de token inválido" });
    }
    const payload = jwt.verify(token, jwtSecret()) as { id?: string; companyId?: string };
    if (!payload.id || !payload.companyId) {
      return res.status(401).json({ message: "Sesión anterior a multi-empresa, vuelve a iniciar sesión" });
    }

    const membership = await prismaRoot.membership.findUnique({
      where: { userId_companyId: { userId: payload.id, companyId: payload.companyId } },
      include: {
        user: { select: { isActive: true, isPlatformOwner: true } },
        company: { select: { suspendedAt: true, suspensionReason: true } },
      },
    });
    if (!membership || !membership.isActive || !membership.user.isActive) {
      return res.status(401).json({ message: "Cuenta desactivada o sin acceso a esta empresa" });
    }

    // Empresa suspendida: solo se deja pasar lo mínimo para mostrarle el aviso y cambiar de empresa.
    // El dueño de la plataforma no se bloquea (puede tener su propia empresa suspendida de prueba).
    if (membership.company.suspendedAt && !membership.user.isPlatformOwner) {
      const route = `${req.method} ${req.originalUrl.split("?")[0]}`;
      if (!SUSPENDED_ALLOWED.has(route)) {
        return res.status(403).json({
          code: "COMPANY_SUSPENDED",
          error: membership.company.suspensionReason || "La cuenta de esta empresa está suspendida. Contacta a soporte.",
        });
      }
    }

    req.user = {
      id: payload.id,
      companyId: payload.companyId,
      role: membership.role,
      permissions: effectivePermissions(membership.role, membership.grantedPermissions, membership.revokedPermissions),
      isPlatformOwner: membership.user.isPlatformOwner,
    };
    runWithCompany(payload.companyId, next);
  } catch {
    res.status(401).json({ message: "acceso no autorizado" });
  }
}

// Exige uno o varios permisos (todos). Va después de Authenticated; los permisos ya vienen calculados.
export function Can(...required: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: "acceso no autorizado" });
    if (!required.every((p) => req.user!.permissions.includes(p))) {
      return res.status(403).json({ message: "No tienes permiso para hacer esto" });
    }
    next();
  };
}

// ¿Tiene el permiso? (para decisiones dentro de un controller o service)
export const can = (user: { permissions: string[] } | undefined, permission: Permission) =>
  Boolean(user?.permissions.includes(permission));

// Solo el dueño de la plataforma (va después de Authenticated)
export function PlatformOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isPlatformOwner) {
    return res.status(403).json({ message: "estas auntenticado pero no tienes acceso" });
  }
  next();
}

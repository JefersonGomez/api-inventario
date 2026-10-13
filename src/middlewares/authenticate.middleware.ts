import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prismaRoot } from "../config/database.ts";
import { runWithCompany } from "../shared/tenant.ts";
import { jwtSecret } from "../config/env.ts";

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
      include: { user: { select: { isActive: true } } },
    });
    if (!membership || !membership.isActive || !membership.user.isActive) {
      return res.status(401).json({ message: "Cuenta desactivada o sin acceso a esta empresa" });
    }

    req.user = { id: payload.id, companyId: payload.companyId, role: membership.role };
    runWithCompany(payload.companyId, next);
  } catch {
    res.status(401).json({ message: "acceso no autorizado" });
  }
}

export function Authorize (...rolesPermitidos: ("ADMIN" | "EMPLOYE")[]){
     return (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            return res.status(401).json({"message":"acceso no autorizado"})
        }

        const verification = (rolesPermitidos as string[]).includes(req.user.role)
        if(!verification){
            return res.status(403).json({"message":"estas auntenticado pero no tienes acceso"})
        }

        next()


    

  }
}


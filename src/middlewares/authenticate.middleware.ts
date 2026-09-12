import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { AuthPayload } from "../types/express.d.ts"
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
        const clave = process.env.JWT_SECRET_KEY || "clave_secreta_por_defecto_desarrollo";
     const verification = jwt.verify(token, clave) as AuthPayload
      if (verification) {
        req.user = verification
        next()
      }
    } catch (err) {
        res.status(401).json({"message":"acceso no autorizado"})
    }
}


export function Authorize (...rolesPermitidos: string[]){
     return (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            return res.status(401).json({"message":"acceso no autorizado"})
        }

        const verification = rolesPermitidos.includes(req.user.role)
        if(!verification){
            return res.status(403).json({"message":"estas auntenticado pero no tienes acceso"})
        }

        next()


    

  }
}


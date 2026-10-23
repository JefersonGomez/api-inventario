import type { Request, Response } from "express";
import { pinStatus } from "../users/pin.service.ts";
import { Register, Login, refreshAccessToken, logout, switchCompany, openSession } from "./auth.service.ts";
import { DEMO_CODES, demoUser } from "../demo/demo.service.ts";

export async function RegisterController(req: Request, res: Response) {
  try {
    const { name, email, password, phone, company } = req.body;
    const userCreated = await Register(name, email, password, { phone, company });
    if (userCreated) {
      res.status(201).json(userCreated);
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function LoginController(req: Request, res: Response) {
  try {
    const { email, password } = req.body;
    const result = await Login(email, password);
    res.status(200).json(result);
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
}
// auth.controller.ts — agregar
export async function refreshController(req: Request, res: Response) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== "string") {
      res.status(400).json({ error: "refreshToken requerido" });
      return;
    }
    const result = await refreshAccessToken(refreshToken);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: (error as Error).message });
  }
}

export async function logoutCotroller(req: Request, res: Response) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken && typeof refreshToken === "string") {
      await logout(refreshToken);
    }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

// usuario de la sesión + sus permisos efectivos en la empresa activa (el frontend decide qué mostrar)
// Demo pública (DEMO_ENABLED=1): entrar sin contraseña como el administrador o el cajero de la ferretería demo
export async function demoInfoHandler(_req: Request, res: Response) {
  res.json(process.env.DEMO_ENABLED === "1" ? { enabled: true, codes: DEMO_CODES } : { enabled: false });
}
export async function demoLoginHandler(req: Request, res: Response) {
  try {
    if (process.env.DEMO_ENABLED !== "1") return res.status(404).json({ error: "La demo no está disponible" });
    const found = await demoUser(req.body?.role === "CASHIER" ? "CASHIER" : "ADMIN");
    if (!found) return res.status(503).json({ error: "La demo se está preparando, intenta en unos minutos" });
    res.json(await openSession(found.userId, found.companyId, true));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function meHandler(req: Request, res: Response) {
  res.json({ user: { ...req.user, ...(await pinStatus(req.user!.id)) } });
}
export async function switchCompanyHandler(req: Request, res: Response) {
  try {
    res.json(await switchCompany(req.user!.id, req.body.companyId));
  } catch (error) {
    res.status(403).json({ error: (error as Error).message });
  }
}

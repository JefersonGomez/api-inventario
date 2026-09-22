import type { Request, Response } from "express";
import { Register, Login,refreshAccessToken,logout } from "./auth.service.ts";

export async function RegisterController(req: Request, res: Response) {
  try {
    const { name, email, password } = req.body;
    const userCreated = await Register(name, email, password);
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

export async function meHandler(req: Request, res: Response) {
  res.json({ user: req.user });
}
import type { Request, Response } from "express";
import { Register, Login } from "./auth.service.ts";

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

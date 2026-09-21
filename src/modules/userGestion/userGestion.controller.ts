import type { Request, Response } from "express"
import { getAllUsers, toggleUserActive } from "./userGestion.service.ts"

export async function getAllUsersController(req: Request, res: Response) {
  try {
    const users = await getAllUsers()
    res.status(200).json(users)
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function toggleUserActiveHandler(
  req: Request<{ id: string }>,
  res: Response
) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const updated = await toggleUserActive(id, req.user!.id);
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
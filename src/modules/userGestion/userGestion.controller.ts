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

export async function toggleUserActiveController(req: Request, res: Response) {
  try {
    const { id } = req.params;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const requestingUserId = req.user!.id;

    const updatedUser = await toggleUserActive(id, requestingUserId);
    res.status(200).json(updatedUser);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
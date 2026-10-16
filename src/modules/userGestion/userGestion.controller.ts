import type { Request, Response } from "express"
import { getAllUsers, toggleUserActive, updateUserAccess, permissionCatalog } from "./userGestion.service.ts"
import { emit, userRoom } from "../../shared/realtime.ts"

export async function getAllUsersController(req: Request, res: Response) {
  try {
    const users = await getAllUsers(res.locals.query)
    res.status(200).json(users)
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export function permissionCatalogHandler(_req: Request, res: Response) {
  res.json(permissionCatalog())
}

export async function updateUserAccessHandler(req: Request<{ id: string }>, res: Response) {
  try {
    res.json(await updateUserAccess(req.params.id, req.body, req.user!.id))
    emit(userRoom(req.params.id), ["me"]) // su pantalla relee sus permisos sin cerrar sesión
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
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
// notifications.controller.ts
import type { Request, Response } from "express";
import * as service from "./notifications.service.ts";
import { markAsRead, markAllAsRead } from "./notifications.persist.ts";

export async function getNotificationsHandler(req: Request, res: Response) {
  try {
    const data = await service.getNotifications(req.user!);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function markAsReadHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }
    const updated = await markAsRead(req.user!.id, id);
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function markAllAsReadHandler(req: Request, res: Response) {
  try {
    const updated = await markAllAsRead(req.user!.id);
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

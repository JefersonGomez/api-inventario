// notifications.controller.ts
import type { Request, Response } from "express";
import * as service from "./notifications.service.ts";

export async function getNotificationsHandler(req: Request, res: Response) {
  try {
    const data = await service.getNotifications();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
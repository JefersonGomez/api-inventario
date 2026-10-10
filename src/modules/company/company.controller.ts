// company.controller.ts
import type { Request, Response } from "express";
import * as service from "./company.service.ts";

export async function getCompanyHandler(_req: Request, res: Response) {
  try {
    res.json(await service.getCompany());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function updateCompanyHandler(req: Request, res: Response) {
  try {
    res.json(await service.updateCompany(req.body.name, req.user!.id));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

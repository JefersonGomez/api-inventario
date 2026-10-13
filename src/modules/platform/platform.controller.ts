// platform.controller.ts
import type { Request, Response } from "express";
import * as service from "./platform.service.ts";

export async function listCompaniesHandler(_req: Request, res: Response) {
  try {
    res.json(await service.listCompanies());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function setPlanHandler(req: Request, res: Response) {
  try {
    await service.setPlan(req.params.id as string, req.body.plan, req.user!.id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function setSuspendedHandler(req: Request, res: Response) {
  try {
    await service.setSuspended(req.params.id as string, req.body.suspended, req.body.reason, req.user!.id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

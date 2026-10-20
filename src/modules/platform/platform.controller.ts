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

// Panel del dueño (Bloque 6A): actividad, registros por semana, medidor de IA y sus propias acciones
export async function overviewHandler(_req: Request, res: Response) {
  try {
    const [activity, signups] = await Promise.all([service.companyActivity(), service.signupsByWeek()]);
    res.json({ activity, signups });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function aiUsageHandler(_req: Request, res: Response) {
  try {
    res.json(await service.aiUsageReport(res.locals.query?.month));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function setAiBudgetHandler(req: Request, res: Response) {
  try {
    const budget = await service.setAiBudget(req.body);
    await service.logPlatformAction(req.user!.id, "aiBudget", { monthlyUsd: budget.monthlyUsd, alertPercent: budget.alertPercent });
    res.json(budget);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function ownerActionsHandler(_req: Request, res: Response) {
  try {
    res.json(await service.ownerActions());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

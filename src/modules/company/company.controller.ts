// company.controller.ts
import type { Request, Response } from "express";
import * as service from "./company.service.ts";
import { onboardingStatus, setOnboardingDismissed } from "./onboarding.service.ts";

export async function getCompanyHandler(_req: Request, res: Response) {
  try {
    res.json(await service.getCompany());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function updateCompanyHandler(req: Request, res: Response) {
  try {
    res.json(await service.updateCompany(req.body, req.user!.id));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function listMyCompaniesHandler(req: Request, res: Response) {
  try {
    res.json(await service.listMyCompanies(req.user!.id));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function createCompanyHandler(req: Request, res: Response) {
  try {
    res.status(201).json(await service.createCompany(req.user!.id, req.body.name, req.body.currency));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

// Guía de primeros pasos (Bloque 6B)
export async function onboardingHandler(_req: Request, res: Response) {
  try {
    res.json(await onboardingStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function dismissOnboardingHandler(req: Request, res: Response) {
  try {
    res.json(await setOnboardingDismissed(req.body?.dismissed !== false));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

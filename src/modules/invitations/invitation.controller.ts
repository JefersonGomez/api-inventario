// invitation.controller.ts
import type { Request, Response } from "express";
import * as service from "./invitation.service.ts";

export async function createInvitationHandler(req: Request, res: Response) {
  try {
    res.status(201).json(await service.createInvitation(req.body.email, req.body.role, req.user!.id));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function listInvitationsHandler(_req: Request, res: Response) {
  try {
    res.json(await service.listPendingInvitations());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function revokeInvitationHandler(req: Request, res: Response) {
  try {
    await service.revokeInvitation(req.params.id as string, req.user!.id);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
}

export async function getInvitationByTokenHandler(req: Request, res: Response) {
  try {
    const info = await service.getInvitationByToken(req.params.token as string);
    if (!info) return res.status(404).json({ error: "Invitación no encontrada" });
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function acceptInvitationHandler(req: Request, res: Response) {
  try {
    res.json(await service.acceptInvitation(req.params.token as string, req.body));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

// purchase-request.controller.ts
import type { Request, Response } from "express";
import * as service from "./purchase-request.service.js";

export async function createPurchaseRequestHandler(req: Request, res: Response) {
  try {
    const { productId, quantity, reason } = req.body;
    const request = await service.createPurchaseRequest(
      productId,
      req.user!.id,
      quantity,
      reason
    );
    res.status(201).json(request);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getAllPurchaseRequestsHandler(req: Request, res: Response) {
  try {
    const requests = await service.getAllPurchaseRequests(req.user!);
    res.status(200).json(requests);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function updatePurchaseRequestStatusHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }
    const { status } = req.body;
    const updated = await service.updatePurchaseRequestStatus(id, status);
    res.status(200).json(updated);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
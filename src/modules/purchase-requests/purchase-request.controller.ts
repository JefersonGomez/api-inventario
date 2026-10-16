// purchase-request.controller.ts
import type { Request, Response } from "express";
import * as service from "./purchase-request.service.js";
import * as productService from "../products/products.service.ts";
import { emit, PURCHASE_MANAGERS, REQUEST_TOPICS, userRoom } from "../../shared/realtime.ts";
export async function createPurchaseRequestHandler(req: Request, res: Response) {
  try {
    const { productId, quantity, reason } = req.body;
    const request = await service.createPurchaseRequest(
      productId,
      req.user!.id,
      quantity,
      reason
    );
    emit(PURCHASE_MANAGERS, REQUEST_TOPICS);
    res.status(201).json(request);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getAllPurchaseRequestsHandler(req: Request, res: Response) {
  try {
    res.status(200).json(await service.listPurchaseRequests(req.user!, res.locals.query));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getPurchaseRequestByIdHandler(req: Request, res: Response) {
  try {
    res.status(200).json(await service.getPurchaseRequestById(req.user!, String(req.params.id)));
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
}

export async function updatePurchaseRequestStatusHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }
    const { status, rejectionReason } = req.body;
    const updated = await service.updatePurchaseRequestStatus(id, status, req.user!.id, rejectionReason);
    emit([PURCHASE_MANAGERS, userRoom(updated.requestedById)], REQUEST_TOPICS);
    res.status(200).json(updated);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getPurchaseRequestAlertsHandler(req: Request, res: Response) {
  try {
    const [expiringSoon, approvedUnfulfilled, expiringSoonProducts] = await Promise.all([
      service.getExpiringSoonRequests(3),
      service.getApprovedUnfulfilledRequests(),
      productService.getExpiringSoonProducts(7), // ← nuevo
    ]);
    res.json({ expiringSoon, approvedUnfulfilled, expiringSoonProducts });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
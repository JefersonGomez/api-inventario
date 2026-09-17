// purchase-order.controller.ts
import type { Request, Response } from "express";
import * as service from "./purchase-order.service.js";

export async function createPurchaseOrderHandler(req: Request, res: Response) {
  try {
    const { supplierId, items, fulfilledRequestIds } = req.body;
    const order = await service.createPurchaseOrder(
      supplierId,
      req.user!.id,
      items,
      fulfilledRequestIds
    );
    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
export async function getAllPurchaseOrdersHandler(req: Request, res: Response) {
  try {
    const orders = await service.getAllPurchaseOrders();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getPurchaseOrderByIdHandler(
  req: Request<{ id: string }>,
  res: Response
) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const order = await service.getPurchaseOrderById(id);
    if (!order) {
      res.status(404).json({ error: "Orden de compra no encontrada" });
      return;
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function receivePurchaseOrderHandler(
  req: Request<{ id: string }>,
  res: Response
) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const order = await service.receivePurchaseOrder(id, req.user!.id);
    res.json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
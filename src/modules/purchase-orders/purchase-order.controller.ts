// purchase-order.controller.ts
import type { Request, Response } from "express";
import * as service from "./purchase-order.service.js";
import { emit, PURCHASE_MANAGERS, EVERYONE, REQUEST_TOPICS, STOCK_TOPICS } from "../../shared/realtime.ts";

export async function createPurchaseOrderHandler(req: Request, res: Response) {
  try {
    const { supplierId, items, fulfilledRequestIds, locationId } = req.body;
    const order = await service.createPurchaseOrder(
      supplierId,
      req.user!.id,
      items,
      fulfilledRequestIds,
      locationId
    );
    emit(PURCHASE_MANAGERS, ["purchase-orders", ...REQUEST_TOPICS]);
    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
export async function getAllPurchaseOrdersHandler(req: Request, res: Response) {
  try {
    res.json(await service.listPurchaseOrders(res.locals.query));
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
    const order = await service.receivePurchaseOrder(id, req.user!.id, req.body?.items, req.body?.invoice);
    emit(EVERYONE, ["purchase-orders", "payables", ...STOCK_TOPICS]);
    res.json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function cancelPurchaseOrderHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const order = await service.cancelPurchaseOrder(req.params.id, req.user!.id, req.body.reason);
    emit(PURCHASE_MANAGERS, ["purchase-orders", ...REQUEST_TOPICS]);
    res.json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function closePurchaseOrderHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const order = await service.closePurchaseOrder(req.params.id, req.user!.id, req.body?.reason);
    emit(PURCHASE_MANAGERS, ["purchase-orders"]);
    res.json(order);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}
export async function sendPurchaseOrderEmailHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const result = await service.sendPurchaseOrderEmail(req.params.id, req.user!.id);
    emit(PURCHASE_MANAGERS, ["purchase-orders"]);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

import type { Request, Response } from "express";
import { createMovement, listMovements } from "./movements.service.ts";
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts";

export async function createMovementController(req: Request, res: Response) {
  try {
    const { productId, type, quantity, reason } = req.body;
    const userId = req.user!.id;

    const movement = await createMovement(productId, userId, type, quantity, reason);
    emit(EVERYONE, STOCK_TOPICS);
    res.status(201).json(movement);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getMovementsController(req: Request, res: Response) {
  try {
    // filtros y página ya validados por validateQuery(movementListQuerySchema)
    return res.status(200).json(await listMovements(res.locals.query));
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
}
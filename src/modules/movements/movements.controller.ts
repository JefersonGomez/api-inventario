import type { Request, Response } from "express";
import { createMovement,getMovements } from "./movements.service.ts";

export async function createMovementController(req: Request, res: Response) {
  try {
    const { productId, type, quantity, reason } = req.body;
    const userId = req.user!.id;

    const movement = await createMovement(productId, userId, type, quantity, reason);
    res.status(201).json(movement);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getMovementsController(req: Request, res: Response) {
  try {
    // 1. Leer el query param usando aserción de tipo para string | undefined
    const productId = req.query.productId as string | undefined;

    // 2. Llamar al servicio pasando productId (si no viene, getMovements manejará el caso traiendo todo)
    const movements = await getMovements(productId);

    // 3. Responder con código 200 y la lista de movimientos
    return res.status(200).json(movements);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
}
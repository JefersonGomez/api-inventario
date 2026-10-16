import type { Request, Response } from "express"
import { authorizeWithPin, generatePinFor, setMyPin } from "./pin.service.ts"

export async function setPinHandler(req: Request, res: Response) {
  try {
    await setMyPin(req.user!.id, req.body.pin, req.body.password)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

// POST /users/:id/pin → { pin } (se muestra una sola vez para entregarlo)
export async function generatePinHandler(req: Request<{ id: string }>, res: Response) {
  try {
    res.status(201).json(await generatePinFor(req.params.id, req.user!))
  } catch (error) {
    res.status((error as { status?: number }).status ?? 400).json({ error: (error as Error).message })
  }
}

// 401 con PIN incorrecto (o de alguien sin ese permiso): cuenta como fallo para el límite de intentos
export async function authorizeHandler(req: Request, res: Response) {
  try {
    const result = await authorizeWithPin(req.user!.id, req.body.pin, req.body.permission, req.body.reason)
    if (!result) return res.status(401).json({ error: "PIN incorrecto o sin permiso para autorizar esto" })
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

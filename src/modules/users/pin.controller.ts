import type { Request, Response } from "express"
import { authorizeWithPin, deleteMyPin, setMyPin } from "./pin.service.ts"

export async function setPinHandler(req: Request, res: Response) {
  try {
    await setMyPin(req.user!.id, req.body.pin, req.body.password)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function deletePinHandler(req: Request, res: Response) {
  try {
    await deleteMyPin(req.user!.id)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
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

import type { Request, Response } from "express"
import { assignPinTo, authorizeWithPin, cashCodeTeam, setMyPin } from "./pin.service.ts"
import { emit, userRoom } from "../../shared/realtime.ts"

export async function setPinHandler(req: Request, res: Response) {
  try {
    await setMyPin(req.user!.id, req.body.pin, req.body.password)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

const status = (error: unknown) => (error as { status?: number }).status ?? 400

// GET /users/cash-codes: personas cuyo código puede asignar quien pide
export async function cashCodeTeamHandler(req: Request, res: Response) {
  try {
    res.json(await cashCodeTeam(req.user!))
  } catch (error) {
    res.status(status(error)).json({ error: (error as Error).message })
  }
}

// POST /users/:id/pin { pin? } → { pin } (se muestra una sola vez para entregarlo)
export async function assignPinHandler(req: Request<{ id: string }>, res: Response) {
  try {
    res.status(201).json(await assignPinTo(req.params.id, req.user!, req.body?.pin))
    emit(userRoom(req.params.id), ["notifications", "me"]) // le llega el aviso al instante
  } catch (error) {
    res.status(status(error)).json({ error: (error as Error).message })
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

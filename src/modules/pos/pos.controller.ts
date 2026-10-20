import type { Request, Response } from "express"
import {
  addCashMovement, closeSession, createRegister, currentSession, getTicket, listCashMovements, listRegisters,
  openSession, renewCodeWithManager, sell, updateRegister,
} from "./pos.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"

const TOPICS = ["cash-registers", "cash-session"]
const fail = (res: Response, error: unknown) => {
  const e = error as { status?: number; code?: string; message: string }
  res.status(e.status ?? 400).json({ error: e.message, ...(e.code && { code: e.code }) })
}
// cada handler: llama al service y responde; los errores traen su status (404, 409, 423…)
const handle =
  (fn: (req: Request<{ id: string }>) => Promise<unknown>, status = 200, topics?: string[]) =>
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const result = await fn(req)
      if (topics) emit(EVERYONE, topics)
      res.status(status).json(result)
    } catch (error) {
      fail(res, error)
    }
  }

export const listRegistersHandler = handle(() => listRegisters())
export const createRegisterHandler = handle((req) => createRegister(req.body, req.user!.id), 201, TOPICS)
export const updateRegisterHandler = handle((req) => updateRegister(req.params.id, req.body, req.user!.id), 200, TOPICS)

export const currentSessionHandler = handle((req) => currentSession(req.user!.id))
export const openSessionHandler = handle((req) => openSession(req.body, req.user!), 201, TOPICS)
export const renewCodeHandler = handle((req) => renewCodeWithManager(req.body, req.user!))
export const addCashMovementHandler = handle((req) => addCashMovement(req.body, req.user!), 201, TOPICS)
export const listCashMovementsHandler = handle((req) => listCashMovements(req.user!.id))
export const closeSessionHandler = handle((req) => closeSession(req.params.id, req.body, req.user!), 200, TOPICS)

export const sellHandler = handle((req) => sell(req.body, req.user!), 201, [...STOCK_TOPICS, ...TOPICS, "documents"])
export const ticketHandler = handle((req) => getTicket(req.params.id))

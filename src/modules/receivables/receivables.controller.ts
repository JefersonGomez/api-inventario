import type { Request, Response } from "express"
import { getAccount, getReceipt, listReceivables, registerPayment, setCreditLimit } from "./receivables.service.ts"
import { emit, EVERYONE } from "../../shared/realtime.ts"

const TOPICS = ["receivables", "customers"]
// cada handler: llama al service y responde; los errores traen su status (403, 404, 409…)
const handle =
  (fn: (req: Request<{ id: string }>, res: Response) => Promise<unknown>, status = 200, topics?: string[]) =>
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const result = await fn(req, res)
      if (topics) emit(EVERYONE, topics)
      res.status(status).json(result)
    } catch (error) {
      const e = error as { status?: number; code?: string; message: string }
      res.status(e.status ?? 400).json({ error: e.message, ...(e.code && { code: e.code }) })
    }
  }

export const listReceivablesHandler = handle((_req, res) => listReceivables(res.locals.query))
export const accountHandler = handle((req) => getAccount(req.params.id))
export const creditLimitHandler = handle((req) => setCreditLimit(req.params.id, req.body, req.user!.id), 200, TOPICS)
export const registerPaymentHandler = handle((req) => registerPayment(req.body, req.user!), 201, [...TOPICS, "cash-session"])
export const receiptHandler = handle((req) => getReceipt(req.params.id))

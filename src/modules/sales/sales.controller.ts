import type { Request, Response } from "express"
import { createReturn, getSale, listSales } from "./sales.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"

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

export const listSalesHandler = handle((_req, res) => listSales(res.locals.query))
export const saleHandler = handle((req) => getSale(req.params.id))
export const returnHandler = handle((req) => createReturn(req.params.id, req.body, req.user!), 201, [
  "sales", "cash-session", "receivables", "notifications", ...STOCK_TOPICS,
])

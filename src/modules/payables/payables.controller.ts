import type { Request, Response } from "express"
import {
  getSupplierAccount, listInvoices, listPayables, registerInvoice, registerSupplierPayment, voidInvoice,
} from "./payables.service.ts"
import { emit, EVERYONE } from "../../shared/realtime.ts"

const TOPICS = ["payables"]
// cada handler: llama al service y responde; los errores traen su status (404…)
const handle =
  (fn: (req: Request<{ id: string }>, res: Response) => Promise<unknown>, status = 200, topics?: string[]) =>
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const result = await fn(req, res)
      if (topics) emit(EVERYONE, topics)
      res.status(status).json(result)
    } catch (error) {
      const e = error as { status?: number; message: string }
      res.status(e.status ?? 400).json({ error: e.message })
    }
  }

export const listPayablesHandler = handle((_req, res) => listPayables(res.locals.query))
export const listInvoicesHandler = handle((_req, res) => listInvoices(res.locals.query))
export const accountHandler = handle((req) => getSupplierAccount(req.params.id))
export const registerInvoiceHandler = handle((req) => registerInvoice(req.body, req.user!.id), 201, TOPICS)
export const voidInvoiceHandler = handle((req) => voidInvoice(req.params.id, req.body.reason, req.user!.id), 200, TOPICS)
export const registerPaymentHandler = handle((req) => registerSupplierPayment(req.body, req.user!.id), 201, TOPICS)

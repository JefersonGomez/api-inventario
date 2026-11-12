import type { Request, Response } from "express"
import {
  getSupplierAccount, listInvoices, listPayables, registerInvoice, registerSupplierPayment, voidInvoice,
} from "./payables.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"
import { importXmlInvoice, previewXmlInvoice } from "./invoice-import.service.ts"
import { respondInvoice, retryResponse } from "./receiver-message.service.ts"
import { receiveInvoiceStock, stockPlan } from "./invoice-stock.service.ts"

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

// ---------- Importar el XML de la factura del proveedor ----------
const uploaded = (req: Request) => ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => f.buffer)
export const previewXmlHandler = handle((req) => previewXmlInvoice(uploaded(req)))
export const importXmlHandler = handle((req) => importXmlInvoice(uploaded(req), req.body, req.user!.id), 201, TOPICS)
// mensaje receptor: aceptar / aceptar en parte / rechazar ante Hacienda, y reintentar o consultar
export const respondHandler = handle((req) => respondInvoice(req.params.id, req.body, req.user!.id), 200, TOPICS)
export const retryResponseHandler = handle((req) => retryResponse(req.params.id), 200, TOPICS)
// la mercadería de la factura entra al inventario: plan (líneas con su producto sugerido) y confirmar
export const stockPlanHandler = handle((req) => stockPlan(req.params.id))
export const receiveStockHandler = handle((req) => receiveInvoiceStock(req.params.id, req.body, req.user!.id), 200, [...TOPICS, ...STOCK_TOPICS])

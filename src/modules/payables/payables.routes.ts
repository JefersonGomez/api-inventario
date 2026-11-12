import { Router } from "express"
import multer from "multer"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import {
  accountHandler, importXmlHandler, listInvoicesHandler, listPayablesHandler, previewXmlHandler, registerInvoiceHandler, receiveStockHandler, registerPaymentHandler, respondHandler, retryResponseHandler, stockPlanHandler, voidInvoiceHandler,
} from "./payables.controller.ts"
import { invoiceSchema, invoicesQuerySchema, payablesQuerySchema, supplierPaymentSchema, voidInvoiceSchema } from "./payables.service.ts"
import { importXmlSchema } from "./invoice-import.service.ts"
import { respondSchema } from "./receiver-message.service.ts"
import { receiveStockSchema } from "./invoice-stock.service.ts"

export const router = Router()

router.get("/", validateQuery(payablesQuerySchema), Authenticated, Can("payables.manage"), listPayablesHandler)
// rutas fijas antes de /:id
router.get("/invoices", validateQuery(invoicesQuerySchema), Authenticated, Can("payables.manage"), listInvoicesHandler)
router.post("/invoices", validate(invoiceSchema), Authenticated, Can("payables.manage"), registerInvoiceHandler)
// XML de la factura del proveedor (+ la respuesta de Hacienda, opcional): en memoria, hasta 2 archivos de 1 MB
const xmlUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 2 } })
router.post("/invoices/xml/preview", Authenticated, Can("payables.manage"), xmlUpload.array("files", 2), previewXmlHandler)
router.post("/invoices/xml", Authenticated, Can("payables.manage"), xmlUpload.array("files", 2), validate(importXmlSchema), importXmlHandler)
router.post("/invoices/:id/void", validate(voidInvoiceSchema), Authenticated, Can("payables.manage"), voidInvoiceHandler)
router.post("/invoices/:id/respond", validate(respondSchema), Authenticated, Can("payables.manage"), respondHandler)
router.post("/invoices/:id/respond/retry", Authenticated, Can("payables.manage"), retryResponseHandler)
// entrada al inventario: necesita también mover stock
router.get("/invoices/:id/stock", Authenticated, Can("payables.manage"), Can("stock.move"), stockPlanHandler)
router.post("/invoices/:id/stock", validate(receiveStockSchema), Authenticated, Can("payables.manage"), Can("stock.move"), receiveStockHandler)
router.post("/payments", validate(supplierPaymentSchema), Authenticated, Can("payables.manage"), registerPaymentHandler)
router.get("/:id", Authenticated, Can("payables.manage"), accountHandler)

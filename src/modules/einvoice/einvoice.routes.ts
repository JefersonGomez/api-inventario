// Facturación electrónica (Bloque 9, fase 1). Enviar y consultar a mano un comprobante ya emitido.
import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { getEInvoiceHandler, refreshEInvoiceHandler, sendEInvoiceHandler, xmlEInvoiceHandler } from "./einvoice.controller.ts"

export const router = Router()

router.get("/documents/:id", Authenticated, Can("company.manage"), getEInvoiceHandler)
router.get("/documents/:id/xml", Authenticated, Can("company.manage"), xmlEInvoiceHandler)
router.post("/documents/:id/send", Authenticated, Can("company.manage"), sendEInvoiceHandler)
router.post("/documents/:id/refresh", Authenticated, Can("company.manage"), refreshEInvoiceHandler)


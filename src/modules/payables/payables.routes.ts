import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import {
  accountHandler, listInvoicesHandler, listPayablesHandler, registerInvoiceHandler, registerPaymentHandler, voidInvoiceHandler,
} from "./payables.controller.ts"
import { invoiceSchema, invoicesQuerySchema, payablesQuerySchema, supplierPaymentSchema, voidInvoiceSchema } from "./payables.service.ts"

export const router = Router()

router.get("/", validateQuery(payablesQuerySchema), Authenticated, Can("payables.manage"), listPayablesHandler)
// rutas fijas antes de /:id
router.get("/invoices", validateQuery(invoicesQuerySchema), Authenticated, Can("payables.manage"), listInvoicesHandler)
router.post("/invoices", validate(invoiceSchema), Authenticated, Can("payables.manage"), registerInvoiceHandler)
router.post("/invoices/:id/void", validate(voidInvoiceSchema), Authenticated, Can("payables.manage"), voidInvoiceHandler)
router.post("/payments", validate(supplierPaymentSchema), Authenticated, Can("payables.manage"), registerPaymentHandler)
router.get("/:id", Authenticated, Can("payables.manage"), accountHandler)

import { Router, type NextFunction, type Request, type Response } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { creditLimitSchema, customerPaymentSchema, receivablesQuerySchema } from "./receivables.service.ts"
import { accountHandler, creditLimitHandler, listReceivablesHandler, receiptHandler, registerPaymentHandler } from "./receivables.controller.ts"

// El estado de cuenta y los recibos los ve quien cobra en la caja o quien maneja las cuentas por cobrar
const CashierOrCollector = (req: Request, res: Response, next: NextFunction) =>
  ["sales.sell", "receivables.manage"].some((p) => req.user!.permissions.includes(p as never))
    ? next()
    : res.status(403).json({ message: "No tienes permiso para hacer esto" })

export const router = Router()

router.get("/", validateQuery(receivablesQuerySchema), Authenticated, Can("receivables.manage"), listReceivablesHandler)
// abono: en la caja (sales.sell + caja abierta) o sin caja (receivables.manage); lo decide el service
router.post("/payments", validate(customerPaymentSchema), Authenticated, CashierOrCollector, registerPaymentHandler)
router.get("/payments/:id", Authenticated, CashierOrCollector, receiptHandler)
router.get("/:id", Authenticated, CashierOrCollector, accountHandler)
router.put("/:id/credit", validate(creditLimitSchema), Authenticated, Can("credit.manage"), creditLimitHandler)

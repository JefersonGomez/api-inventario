import { Router, type NextFunction, type Request, type Response } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import {
  classifyHandler, createAccountHandler, createDepositHandler, importHandler, listAccountsHandler, listDepositsHandler,
  transactionsHandler, updateAccountHandler,
} from "./banks.controller.ts"
import { bankAccountSchema, classifySchema, depositSchema, depositsQuerySchema, importSchema, transactionsQuerySchema } from "./banks.service.ts"

// Los depósitos de efectivo los registra también la jefa de caja (cash.reconcile), que necesita ver las cuentas
const BanksOrCash = (req: Request, res: Response, next: NextFunction) =>
  ["banks.manage", "cash.reconcile"].some((p) => req.user!.permissions.includes(p as never))
    ? next()
    : res.status(403).json({ message: "No tienes permiso para hacer esto" })

export const router = Router()

router.get("/accounts", Authenticated, BanksOrCash, listAccountsHandler)
router.post("/accounts", validate(bankAccountSchema), Authenticated, Can("banks.manage"), createAccountHandler)
router.put("/accounts/:id", validate(bankAccountSchema), Authenticated, Can("banks.manage"), updateAccountHandler)
router.post("/accounts/:id/import", validate(importSchema), Authenticated, Can("banks.manage"), importHandler)
router.get("/accounts/:id/transactions", validateQuery(transactionsQuerySchema), Authenticated, Can("banks.manage"), transactionsHandler)
router.patch("/transactions/:id", validate(classifySchema), Authenticated, Can("banks.manage"), classifyHandler)
router.get("/deposits", validateQuery(depositsQuerySchema), Authenticated, BanksOrCash, listDepositsHandler)
router.post("/deposits", validate(depositSchema), Authenticated, BanksOrCash, createDepositHandler)

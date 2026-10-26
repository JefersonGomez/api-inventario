import type { Request, Response } from "express"
import {
  classifyTransaction, createAccount, createDeposit, importStatement, listAccounts, listDeposits, listTransactions, updateAccount,
} from "./banks.service.ts"
import { emit, EVERYONE } from "../../shared/realtime.ts"

const TOPICS = ["banks"]
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

export const listAccountsHandler = handle(() => listAccounts())
export const createAccountHandler = handle((req) => createAccount(req.body, req.user!.id), 201, TOPICS)
export const updateAccountHandler = handle((req) => updateAccount(req.params.id, req.body, req.user!.id), 200, TOPICS)
export const importHandler = handle((req) => importStatement(req.params.id, req.body, req.user!.id), 201, TOPICS)
export const transactionsHandler = handle((req, res) => listTransactions(req.params.id, res.locals.query))
export const classifyHandler = handle((req) => classifyTransaction(req.params.id, req.body, req.user!.id), 200, TOPICS)
export const createDepositHandler = handle((req) => createDeposit(req.body, req.user!.id), 201, TOPICS)
export const listDepositsHandler = handle((_req, res) => listDeposits(res.locals.query))

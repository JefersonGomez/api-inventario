import { Router, type NextFunction, type Request, type Response } from "express"
import { Authenticated } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { pinLimiter } from "../../middlewares/rate-limit.middleware.ts"
import { returnSchema, salesQuerySchema } from "./sales.service.ts"
import { listSalesHandler, returnHandler, saleHandler } from "./sales.controller.ts"

// con alguno de estos permisos (Can pide todos)
const AnyOf = (...perms: string[]) => (req: Request, res: Response, next: NextFunction) =>
  perms.some((p) => req.user!.permissions.includes(p as never)) ? next() : res.status(403).json({ message: "No tienes permiso para hacer esto" })

export const router = Router()

// ver ventas: quien vende, quien autoriza devoluciones o quien ve reportes
router.get("/", validateQuery(salesQuerySchema), Authenticated, AnyOf("sales.sell", "sales.void", "reports.view"), listSalesHandler)
router.get("/:id", Authenticated, AnyOf("sales.sell", "sales.void", "reports.view"), saleHandler)
// devolver: en la caja o desde Ventas; siempre lo autoriza un encargado con su código (sales.void)
router.post("/:id/returns", validate(returnSchema), Authenticated, AnyOf("sales.sell", "sales.void"), pinLimiter, returnHandler)

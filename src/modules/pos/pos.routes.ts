import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { pinLimiter } from "../../middlewares/rate-limit.middleware.ts"
import {
  cashMovementSchema, closeSessionSchema, createRegisterSchema, openSessionSchema, renewCodeSchema, saleSchema, updateRegisterSchema,
} from "./pos.service.ts"
import {
  addCashMovementHandler, closeSessionHandler, createRegisterHandler, currentSessionHandler, listCashMovementsHandler,
  listRegistersHandler, openSessionHandler, renewCodeHandler, sellHandler, ticketHandler, updateRegisterHandler,
} from "./pos.controller.ts"

export const router = Router()

// Cajas: las configura quien administra la empresa; las ve quien abre caja (para elegir cuál)
router.get("/registers", Authenticated, Can("cash.manage"), listRegistersHandler)
router.post("/registers", validate(createRegisterSchema), Authenticated, Can("company.manage"), createRegisterHandler)
router.patch("/registers/:id", validate(updateRegisterSchema), Authenticated, Can("company.manage"), updateRegisterHandler)

// Turno de caja de quien está logueado
router.get("/session", Authenticated, Can("cash.manage"), currentSessionHandler)
router.post("/session", validate(openSessionSchema), Authenticated, Can("cash.manage"), pinLimiter, openSessionHandler)
router.post("/session/renew-code", validate(renewCodeSchema), Authenticated, Can("cash.manage"), pinLimiter, renewCodeHandler)
router.get("/session/movements", Authenticated, Can("cash.manage"), listCashMovementsHandler)
router.post("/session/movements", validate(cashMovementSchema), Authenticated, Can("cash.manage"), addCashMovementHandler)
router.post("/sessions/:id/close", validate(closeSessionSchema), Authenticated, Can("cash.manage"), closeSessionHandler)

// Venta y tiquete
router.post("/sales", validate(saleSchema), Authenticated, Can("sales.sell"), sellHandler)
router.get("/tickets/:id", Authenticated, Can("sales.sell"), ticketHandler)

import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { pinLimiter } from "../../middlewares/rate-limit.middleware.ts"
import {
  cashMovementSchema, closeSessionSchema, createRegisterSchema, discountTypeSchema, openSessionSchema, reconcileSchema, renewCodeSchema, saleSchema,
  sessionListQuerySchema, updateRegisterSchema,
} from "./pos.service.ts"
import {
  addCashMovementHandler, closeSessionHandler, createDiscountTypeHandler, createRegisterHandler, currentSessionHandler,
  listCashMovementsHandler, listDiscountTypesHandler, updateDiscountTypeHandler,
  listRegistersHandler, listSessionsHandler, openSessionHandler, reconcileHandler, renewCodeHandler, sellHandler, sessionReportHandler,
  ticketHandler, updateRegisterHandler,
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
// Arqueos (jefa de caja): cierres pendientes, reporte del turno y el arqueo
router.get("/sessions", validateQuery(sessionListQuerySchema), Authenticated, Can("cash.reconcile"), listSessionsHandler)
router.get("/sessions/:id/report", Authenticated, sessionReportHandler) // el cajero ve el suyo (sin el esperado)
router.post("/sessions/:id/reconcile", validate(reconcileSchema), Authenticated, Can("cash.reconcile"), reconcileHandler)

// Tipos de descuento: los crea el admin; el POS los lista para elegir
router.get("/discount-types", Authenticated, listDiscountTypesHandler)
router.post("/discount-types", validate(discountTypeSchema), Authenticated, Can("company.manage"), createDiscountTypeHandler)
router.put("/discount-types/:id", validate(discountTypeSchema), Authenticated, Can("company.manage"), updateDiscountTypeHandler)

// Venta y tiquete
// con código de encargado (negativas o descuentos) cuenta para el límite de intentos de PIN
const withPin = (req: { body: { negativePin?: string; discountPin?: string; creditPin?: string } }) =>
  !!(req.body.negativePin || req.body.discountPin || req.body.creditPin)
router.post("/sales", validate(saleSchema), Authenticated, Can("sales.sell"), (req, res, next) => (withPin(req) ? pinLimiter(req, res, next) : next()), sellHandler)
router.get("/tickets/:id", Authenticated, Can("sales.sell"), ticketHandler)

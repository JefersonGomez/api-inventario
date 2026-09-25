import { Router } from "express";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import {
  getLowStockController,
  getMovementsReportController,
  getInventoryValueController,getInventoryValueBreakdownHandler
} from "./report.controller.ts";

export const router = Router();

router.get("/low-stock", Authenticated, getLowStockController);
router.get("/movements", Authenticated, getMovementsReportController);
router.get("/inventory-value", Authenticated, getInventoryValueController);
// reports.router.ts — agregar
router.get("/inventory-value-breakdown", Authenticated, getInventoryValueBreakdownHandler);
import { Router } from "express";
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts";
import {
  getLowStockController,
  getMovementsReportController,
  getInventoryValueController,getInventoryValueBreakdownHandler,getStockForecastHandler,
  getDashboardController,
} from "./report.controller.ts";

export const router = Router();

router.get("/low-stock", Authenticated, Can("reports.view"), getLowStockController);
router.get("/dashboard", Authenticated, getDashboardController);
router.get("/movements", Authenticated, Can("reports.view"), getMovementsReportController);
router.get("/inventory-value", Authenticated, Can("reports.view", "costs.view"), getInventoryValueController);
// reports.router.ts — agregar
router.get("/inventory-value-breakdown", Authenticated, Can("reports.view", "costs.view"), getInventoryValueBreakdownHandler);
router.get("/stock-forecast", Authenticated, Can("reports.view"), getStockForecastHandler);
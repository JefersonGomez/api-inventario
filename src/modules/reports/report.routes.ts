import { Router } from "express";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import {
  getLowStockController,
  getMovementsReportController,
  getInventoryValueController
} from "./report.controller.ts";

export const router = Router();

router.get("/low-stock", Authenticated, getLowStockController);
router.get("/movements", Authenticated, getMovementsReportController);
router.get("/inventory-value", Authenticated, getInventoryValueController);
import { Router } from "express";
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts";
import {
  getLowStockController,
  getMovementsReportController,
  getInventoryValueController,getInventoryValueBreakdownHandler,getStockForecastHandler,
  getDashboardController, peekDailySummaryHandler, dailySummaryHandler, summaryHistoryHandler,
  mySalesHandler, salesReportHandler, salesTodayHandler, vatReportHandler, saveVatPeriodHandler, accountantPackageHandler,
} from "./report.controller.ts";
import { movementsReportQuerySchema, mySalesQuerySchema, salesReportQuerySchema } from "./sales-report.service.ts";
import { vatPeriodSchema, vatReportQuerySchema } from "./vat-report.service.ts";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { dailySummaryQuerySchema, summaryHistorySchema } from "./daily-summary.service.ts";

export const router = Router();

router.get("/low-stock", Authenticated, Can("reports.view"), getLowStockController);
router.get("/dashboard", Authenticated, getDashboardController);
router.get("/movements", validateQuery(movementsReportQuerySchema), Authenticated, Can("reports.view"), getMovementsReportController);
router.get("/inventory-value", Authenticated, Can("reports.view", "costs.view"), getInventoryValueController);
// reports.router.ts — agregar
router.get("/inventory-value-breakdown", Authenticated, Can("reports.view", "costs.view"), getInventoryValueBreakdownHandler);
router.get("/stock-forecast", Authenticated, Can("reports.view"), getStockForecastHandler);
// resumen del día: GET lo guardado (sin gastar), POST lo genera una vez al día
router.get("/daily-summary", validateQuery(dailySummaryQuerySchema), Authenticated, Can("reports.view"), peekDailySummaryHandler);
router.post("/daily-summary", validateQuery(dailySummaryQuerySchema), Authenticated, Can("reports.view"), dailySummaryHandler);
// historial de resúmenes del día (paginado; ?all=1 para descargarlo entero)
router.get("/daily-summaries", validateQuery(summaryHistorySchema), Authenticated, Can("reports.view"), summaryHistoryHandler);
// ventas: el reporte del período (la ganancia solo con costs.view), las de hoy para el Panel y las del cajero
router.get("/sales", validateQuery(salesReportQuerySchema), Authenticated, Can("reports.view"), salesReportHandler);
router.get("/sales-today", Authenticated, Can("reports.view"), salesTodayHandler);
router.get("/my-sales", validateQuery(mySalesQuerySchema), Authenticated, Can("sales.sell"), mySalesHandler);
// IVA del mes (54B): ?month=AAAA-MM; PUT guarda la prorrata y la retención de tarjeta de ese mes
router.get("/vat", validateQuery(vatReportQuerySchema), Authenticated, Can("accounting.view"), vatReportHandler);
router.put("/vat", validateQuery(vatReportQuerySchema), validate(vatPeriodSchema), Authenticated, Can("accounting.view"), saveVatPeriodHandler);
// Paquete para el contador: todo el mes en un JSON que el frontend baja como Excel
router.get("/accountant-package", validateQuery(vatReportQuerySchema), Authenticated, Can("accounting.view"), accountantPackageHandler);

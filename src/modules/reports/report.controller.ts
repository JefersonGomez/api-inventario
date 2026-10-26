import type { Request, Response } from "express";
import { getLowStockReport, getMovementsReport, getInventoryValueReport,getInventoryValueBreakdown,getStockForecast, getDashboardSummary } from "./report.service.ts";
import { getDailySummary, peekDailySummary, summaryHistory } from "./daily-summary.service.ts";
import { getMySales, getSalesReport, getSalesToday } from "./sales-report.service.ts";

export async function getDashboardController(req: Request, res: Response) {
  try {
    // inicio del mes según el navegador; sin él (o inválido), el del servidor
    const raw = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    const now = new Date();
    const since = raw && !Number.isNaN(raw.getTime()) ? raw : new Date(now.getFullYear(), now.getMonth(), 1);
    res.status(200).json(await getDashboardSummary(req.user!, since));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getLowStockController(req: Request, res: Response) {
  try {
    const report = await getLowStockReport();
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getMovementsReportController(req: Request, res: Response) {
  try {
    const { from, to } = res.locals.query as { from?: string; to?: string };

    const report = await getMovementsReport(from, to);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getInventoryValueController(req: Request, res: Response) {
  try {
    const report = await getInventoryValueReport();
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}


// reports.controller.ts — agregar
export async function getInventoryValueBreakdownHandler(req: Request, res: Response) {
  try {
    const { days } = req.query;
    const daysThreshold = days ? Number(days) : 60;

    if (isNaN(daysThreshold) || daysThreshold <= 0) {
      res.status(400).json({ error: "El parámetro 'days' debe ser un número positivo" });
      return;
    }

    const breakdown = await getInventoryValueBreakdown(daysThreshold);
    res.json(breakdown);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

// reports.controller.ts — agregar
export async function getStockForecastHandler(req: Request, res: Response) {
  try {
    const { velocityDays, alertDays } = req.query;
    const velocityWindowDays = velocityDays ? Number(velocityDays) : 30;
    const alertThresholdDays = alertDays ? Number(alertDays) : 14;

    if (isNaN(velocityWindowDays) || velocityWindowDays <= 0 || isNaN(alertThresholdDays) || alertThresholdDays <= 0) {
      res.status(400).json({ error: "Los parámetros deben ser números positivos" });
      return;
    }

    const forecast = await getStockForecast(velocityWindowDays, alertThresholdDays);
    res.json(forecast);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
// Resumen del día con IA (Bloque 6D): GET = lo guardado de hoy (sin gastar); POST = generarlo si falta
export async function peekDailySummaryHandler(_req: Request, res: Response) {
  try {
    res.json(await peekDailySummary(res.locals.query));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function dailySummaryHandler(req: Request, res: Response) {
  try {
    // ?force=1: volver a generar (queda también el anterior en el historial)
    res.json(await getDailySummary(res.locals.query, req.user!.id, req.query.force === "1"));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function summaryHistoryHandler(_req: Request, res: Response) {
  try {
    res.json(await summaryHistory(res.locals.query));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

// Ventas (7D-1): reporte del período, ventas de hoy (Panel) y las del cajero en el mes
const reply = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.status(200).json(await fn(req, res));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
};
export const salesReportHandler = reply((req, res) => getSalesReport(res.locals.query, req.user!));
export const salesTodayHandler = reply(() => getSalesToday());
export const mySalesHandler = reply((req, res) => getMySales(res.locals.query, req.user!.id));

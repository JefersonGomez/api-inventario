import type { Request, Response } from "express";
import { getLowStockReport, getMovementsReport, getInventoryValueReport,getInventoryValueBreakdown } from "./report.service.ts";

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
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

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
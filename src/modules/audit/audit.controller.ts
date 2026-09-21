import type { Request, Response } from "express";
import * as service from "./audit.service.ts";

export async function getAuditLogsHandler(req: Request, res: Response) {
  try {
    const { entityType } = req.query;
    const logs = await service.getAuditLogs(
      typeof entityType === "string" ? entityType : undefined
    );
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

export async function getAuditMetricsHandler(req: Request, res: Response) {
  try {
    const metrics = await service.getAuditMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
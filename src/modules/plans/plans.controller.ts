import type { Request, Response } from "express";
import { BILLING, PLANS, PRICES } from "../../config/plans.ts";

// Orden en que se ofrecen; aiImportsPerMonth no se publica (es un detalle interno); aiChatsPerMonth sí
const ORDER = ["INVOICING", "BASIC", "PRO", "BUSINESS"] as const;

export function publicPlansHandler(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=300");
  res.json(
    ORDER.map((code) => {
      const { aiImportsPerMonth: _ai, ...limits } = PLANS[code];
      return { code, ...limits, prices: PRICES[code], trialDays: BILLING.trialDays };
    })
  );
}

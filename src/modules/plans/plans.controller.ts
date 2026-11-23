import type { Request, Response } from "express";
import { PLANS } from "../../config/plans.ts";

// Orden en que se ofrecen; aiImportsPerMonth no se publica (es un detalle interno)
const ORDER = ["INVOICING", "BASIC", "PRO", "BUSINESS"] as const;

export function publicPlansHandler(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=300");
  res.json(
    ORDER.map((code) => {
      const { aiImportsPerMonth: _ai, ...limits } = PLANS[code];
      return { code, ...limits };
    })
  );
}

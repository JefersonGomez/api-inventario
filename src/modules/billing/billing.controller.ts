import type { Request, Response } from "express";
import { getSubscription, updateSubscription } from "./billing.service.ts";

type HttpError = Error & { status?: number; code?: string };
const fail = (res: Response, err: unknown) => {
  const e = err as HttpError;
  res.status(e.status ?? 500).json({ error: e.message, ...(e.code && { code: e.code }) });
};

export async function getSubscriptionHandler(req: Request, res: Response) {
  try {
    res.json(await getSubscription(req.user!.companyId, req.user!.id));
  } catch (err) {
    fail(res, err);
  }
}

export async function updateSubscriptionHandler(req: Request, res: Response) {
  try {
    res.json(await updateSubscription(req.user!.companyId, req.user!.id, req.body));
  } catch (err) {
    fail(res, err);
  }
}

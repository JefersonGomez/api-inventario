import type { Request, Response } from "express";
import { getSubscription, updateSubscription } from "./billing.service.ts";
import { cardSetup, listPayments, pay, paySinpe, syncPayment } from "./payments.service.ts";

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

const handle = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try {
    res.status(status).json(await fn(req));
  } catch (err) {
    fail(res, err);
  }
};

export const cardSetupHandler = handle((req) => cardSetup(req.user!.companyId, req.user!.id));
export const payHandler = handle((req) => pay(req.user!.companyId, req.user!.id, req.body?.paymentMethodId), 201);
export const syncPaymentHandler = handle((req) => syncPayment(req.user!.companyId, req.user!.id, String(req.params.id)));
export const listPaymentsHandler = handle((req) => listPayments(req.user!.companyId, req.user!.id));
export const paySinpeHandler = handle((req) => paySinpe(req.user!.companyId, req.user!.id, req.body), 201);

// billing.routes.ts — suscripción de la cuenta (fase de cobro). Cualquiera de la empresa ve el estado
// (para mostrar el aviso); solo el dueño cambia plan o periodo (lo valida el service).
import { Router } from "express";
import { validate } from "../../middlewares/validate.middleware.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { sensitiveLimiter } from "../../middlewares/rate-limit.middleware.ts";
import { paySchema, updateSubscriptionSchema } from "./billing.schema.ts";
import {
  cardSetupHandler, getSubscriptionHandler, listPaymentsHandler, payHandler, syncPaymentHandler, updateSubscriptionHandler,
} from "./billing.controller.ts";

export const billingRouter = Router();
billingRouter.get("/subscription", Authenticated, getSubscriptionHandler);
billingRouter.put("/subscription", validate(updateSubscriptionSchema), Authenticated, updateSubscriptionHandler);

// pago con tarjeta (C2, ONVO): solo el dueño (lo valida el service). Límite de intentos para no disparar el antifraude.
billingRouter.get("/card-setup", Authenticated, cardSetupHandler);
billingRouter.post("/pay", sensitiveLimiter, validate(paySchema), Authenticated, payHandler);
billingRouter.post("/payments/:id/sync", Authenticated, syncPaymentHandler);
billingRouter.get("/payments", Authenticated, listPaymentsHandler);

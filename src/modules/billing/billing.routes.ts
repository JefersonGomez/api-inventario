// billing.routes.ts — suscripción de la cuenta (fase de cobro). Cualquiera de la empresa ve el estado
// (para mostrar el aviso); solo el dueño cambia plan o periodo (lo valida el service).
import { Router } from "express";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { sensitiveLimiter } from "../../middlewares/rate-limit.middleware.ts";
import { cancelSchema, paySchema, paySinpeSchema, updateSubscriptionSchema, upgradeQuoteSchema } from "./billing.schema.ts";
import {
  cancelHandler, cardSetupHandler, getSubscriptionHandler, upgradeQuoteHandler, listPaymentsHandler, payHandler, paySinpeHandler, syncPaymentHandler, updateSubscriptionHandler,
} from "./billing.controller.ts";

export const billingRouter = Router();
billingRouter.get("/subscription", Authenticated, getSubscriptionHandler);
billingRouter.put("/subscription", validate(updateSubscriptionSchema), Authenticated, updateSubscriptionHandler);

// pago con tarjeta (C2, ONVO): solo el dueño (lo valida el service). Límite de intentos para no disparar el antifraude.
billingRouter.get("/card-setup", Authenticated, cardSetupHandler);
billingRouter.post("/pay", sensitiveLimiter, validate(paySchema), Authenticated, payHandler);
billingRouter.post("/payments/:id/sync", Authenticated, syncPaymentHandler);
billingRouter.get("/payments", Authenticated, listPaymentsHandler);
// SINPE Móvil (C3): genera el cobro (a qué número y cuánto transferir); el navegador consulta /payments/:id/sync
billingRouter.post("/pay-sinpe", sensitiveLimiter, validate(paySinpeSchema), Authenticated, paySinpeHandler);
// C5: cancelar / reactivar la renovación y cotizar la diferencia para subir de plan
billingRouter.put("/cancel", validate(cancelSchema), Authenticated, cancelHandler);
billingRouter.get("/upgrade-quote", validateQuery(upgradeQuoteSchema), Authenticated, upgradeQuoteHandler);

// billing.routes.ts — suscripción de la cuenta (fase de cobro). Cualquiera de la empresa ve el estado
// (para mostrar el aviso); solo el dueño cambia plan o periodo (lo valida el service).
import { Router } from "express";
import { validate } from "../../middlewares/validate.middleware.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { updateSubscriptionSchema } from "./billing.schema.ts";
import { getSubscriptionHandler, updateSubscriptionHandler } from "./billing.controller.ts";

export const billingRouter = Router();
billingRouter.get("/subscription", Authenticated, getSubscriptionHandler);
billingRouter.put("/subscription", validate(updateSubscriptionSchema), Authenticated, updateSubscriptionHandler);

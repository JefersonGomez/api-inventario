// plans.routes.ts — límites de cada plan, públicos (los muestra la landing en Precios). Sin precios:
// los montos viven en la configuración de la landing hasta la fase de planes de pago.
import { Router } from "express";
import { publicPlansHandler } from "./plans.controller.ts";

export const plansRouter = Router();
plansRouter.get("/", publicPlansHandler);

// plans.routes.ts — límites y precios de cada plan, públicos (los muestra la landing en Precios).
import { Router } from "express";
import { publicPlansHandler } from "./plans.controller.ts";

export const plansRouter = Router();
plansRouter.get("/", publicPlansHandler);

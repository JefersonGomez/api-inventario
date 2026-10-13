// platform.routes.ts — todo solo para el dueño de la plataforma
import { Router } from "express";
import { Authenticated, PlatformOwner } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { setPlanSchema, setSuspendedSchema } from "./platform.schema.ts";
import { listCompaniesHandler, setPlanHandler, setSuspendedHandler } from "./platform.controller.ts";

export const platformRouter = Router();

platformRouter.get("/companies", Authenticated, PlatformOwner, listCompaniesHandler);
platformRouter.patch("/companies/:id/plan", validate(setPlanSchema), Authenticated, PlatformOwner, setPlanHandler);
platformRouter.patch("/companies/:id/suspension", validate(setSuspendedSchema), Authenticated, PlatformOwner, setSuspendedHandler);

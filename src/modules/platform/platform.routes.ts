// platform.routes.ts — todo solo para el dueño de la plataforma
import { Router } from "express";
import { Authenticated, PlatformOwner } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { validateQuery } from "../../middlewares/validate.middleware.ts";
import { adminSubscriptionSchema, aiBudgetSchema, aiUsageQuerySchema, setPlanSchema, setSuspendedSchema } from "./platform.schema.ts";
import {
  adminSubscriptionHandler, aiUsageHandler, einvoiceIssuesHandler, listSubscriptionsHandler, listCompaniesHandler, overviewHandler, ownerActionsHandler, setAiBudgetHandler, setPlanHandler, setSuspendedHandler,
} from "./platform.controller.ts";

export const platformRouter = Router();

platformRouter.get("/companies", Authenticated, PlatformOwner, listCompaniesHandler);
platformRouter.patch("/companies/:id/plan", validate(setPlanSchema), Authenticated, PlatformOwner, setPlanHandler);
platformRouter.patch("/companies/:id/suspension", validate(setSuspendedSchema), Authenticated, PlatformOwner, setSuspendedHandler);
platformRouter.get("/overview", Authenticated, PlatformOwner, overviewHandler);
platformRouter.get("/ai-usage", validateQuery(aiUsageQuerySchema), Authenticated, PlatformOwner, aiUsageHandler);
platformRouter.put("/ai-budget", validate(aiBudgetSchema), Authenticated, PlatformOwner, setAiBudgetHandler);
platformRouter.get("/actions", Authenticated, PlatformOwner, ownerActionsHandler);
platformRouter.get("/einvoice-issues", Authenticated, PlatformOwner, einvoiceIssuesHandler);
platformRouter.get("/subscriptions", Authenticated, PlatformOwner, listSubscriptionsHandler);
platformRouter.patch("/subscriptions/:userId", validate(adminSubscriptionSchema), Authenticated, PlatformOwner, adminSubscriptionHandler);

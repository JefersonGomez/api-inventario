// notifications.router.ts
import { Router } from "express";
import { Authenticated} from "../../middlewares/authenticate.middleware.ts";
import { Authorize } from "../../middlewares/authenticate.middleware.ts";
import { getNotificationsHandler } from "./notifications.controller.ts";

export const notificationsRouter = Router();
notificationsRouter.get("/", Authenticated, Authorize("ADMIN"), getNotificationsHandler);
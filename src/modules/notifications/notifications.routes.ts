// notifications.router.ts
import { Router } from "express";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import {
  getNotificationsHandler,
  markAsReadHandler,
  markAllAsReadHandler,
} from "./notifications.controller.ts";

// cualquier usuario autenticado: cada rol ve lo suyo (ver notifications.service.ts)
export const notificationsRouter = Router();
notificationsRouter.get("/", Authenticated, getNotificationsHandler);
// read-all antes de /:id/read para que no lo capture el parámetro
notificationsRouter.patch("/read-all", Authenticated, markAllAsReadHandler);
notificationsRouter.patch("/:id/read", Authenticated, markAsReadHandler);

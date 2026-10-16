// invitation.routes.ts
import { Router } from "express";
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { sensitiveLimiter } from "../../middlewares/rate-limit.middleware.ts";
import { createInvitationSchema, acceptInvitationSchema } from "./invitation.schema.ts";
import {
  createInvitationHandler, listInvitationsHandler, revokeInvitationHandler,
  getInvitationByTokenHandler, acceptInvitationHandler,
} from "./invitation.controller.ts";

export const invitationRouter = Router();

// públicas: quien recibe el link todavía no tiene sesión (rutas fijas antes de "/:id")
invitationRouter.get("/token/:token", sensitiveLimiter, getInvitationByTokenHandler);
invitationRouter.post("/token/:token/accept", sensitiveLimiter, validate(acceptInvitationSchema), acceptInvitationHandler);

// admin de la empresa activa
invitationRouter.get("/", Authenticated, Can("users.manage"), listInvitationsHandler);
invitationRouter.post("/", validate(createInvitationSchema), Authenticated, Can("users.manage"), createInvitationHandler);
invitationRouter.delete("/:id", Authenticated, Can("users.manage"), revokeInvitationHandler);

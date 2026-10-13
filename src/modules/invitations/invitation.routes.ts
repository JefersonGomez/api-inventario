// invitation.routes.ts
import { Router } from "express";
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts";
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
invitationRouter.get("/", Authenticated, Authorize("ADMIN"), listInvitationsHandler);
invitationRouter.post("/", validate(createInvitationSchema), Authenticated, Authorize("ADMIN"), createInvitationHandler);
invitationRouter.delete("/:id", Authenticated, Authorize("ADMIN"), revokeInvitationHandler);

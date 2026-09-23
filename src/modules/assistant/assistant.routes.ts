import { Router } from "express";
import { validate } from "../../middlewares/validate.middleware.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { chatMessageSchema } from "./assitant.schema.ts";
import { chatHandler } from "./assistant.controller.ts";

export const assistantRouter = Router();

assistantRouter.post(
  "/chat",
  validate(chatMessageSchema), // ← nuevo, antes que Authenticated como siempre
  Authenticated,
  chatHandler
);
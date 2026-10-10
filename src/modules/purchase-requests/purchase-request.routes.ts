// purchase-request.router.ts
import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { createCommentSchema } from "../comments/comment.schema.ts";
import { getCommentsHandler, addCommentHandler } from "../comments/comment.controller.ts";
import {
  createPurchaseRequestSchema,
  updateStatusSchema,
} from "./purchase-request.schema.ts";
import {
  createPurchaseRequestHandler,
  getAllPurchaseRequestsHandler,
  updatePurchaseRequestStatusHandler,
  getPurchaseRequestAlertsHandler
  
} from "./purchase-request.controller.ts";

export const purchaseRequestRouter = Router();

purchaseRequestRouter.post(
  "/",
  validate(createPurchaseRequestSchema),
  Authenticated,
  createPurchaseRequestHandler
);

purchaseRequestRouter.get("/", Authenticated, getAllPurchaseRequestsHandler);

purchaseRequestRouter.patch(
  "/:id/status",
  validate(updateStatusSchema),
  Authenticated,
  Authorize("ADMIN"),
  updatePurchaseRequestStatusHandler
);

purchaseRequestRouter.get(
  "/alerts",
  Authenticated,
  Authorize("ADMIN"),
  getPurchaseRequestAlertsHandler
);

// hilo de comentarios: quien pidió la solicitud y los admins (el service valida el acceso)
purchaseRequestRouter.get("/:id/comments", Authenticated, getCommentsHandler("request"));
purchaseRequestRouter.post(
  "/:id/comments",
  validate(createCommentSchema),
  Authenticated,
  addCommentHandler("request")
);

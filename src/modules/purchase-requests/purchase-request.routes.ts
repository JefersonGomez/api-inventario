// purchase-request.router.ts
import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { createCommentSchema } from "../comments/comment.schema.ts";
import { getCommentsHandler, addCommentHandler } from "../comments/comment.controller.ts";
import {
  createPurchaseRequestSchema,
  updateStatusSchema,
  purchaseRequestListQuerySchema,
} from "./purchase-request.schema.ts";
import {
  createPurchaseRequestHandler,
  getAllPurchaseRequestsHandler,
  updatePurchaseRequestStatusHandler,
  getPurchaseRequestAlertsHandler,
  getPurchaseRequestByIdHandler,
} from "./purchase-request.controller.ts";

export const purchaseRequestRouter = Router();

purchaseRequestRouter.post(
  "/",
  validate(createPurchaseRequestSchema),
  Authenticated,
  createPurchaseRequestHandler
);

purchaseRequestRouter.get("/", validateQuery(purchaseRequestListQuerySchema), Authenticated, getAllPurchaseRequestsHandler);

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
// después de /alerts: si no, "/:id" la capturaría
purchaseRequestRouter.get("/:id", Authenticated, getPurchaseRequestByIdHandler);
purchaseRequestRouter.post(
  "/:id/comments",
  validate(createCommentSchema),
  Authenticated,
  addCommentHandler("request")
);

// purchase-request.router.ts
import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import {
  createPurchaseRequestSchema,
  updateStatusSchema,
} from "./purchase-request.schema.js";
import {
  createPurchaseRequestHandler,
  getAllPurchaseRequestsHandler,
  updatePurchaseRequestStatusHandler,
} from "./purchase-request.controller.js";

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
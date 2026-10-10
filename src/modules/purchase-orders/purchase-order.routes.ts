// purchase-order.router.ts
import { Router } from "express";
import { validate } from "../../middlewares/validate.middleware.ts";
import { createCommentSchema } from "../comments/comment.schema.ts";
import { getCommentsHandler, addCommentHandler } from "../comments/comment.controller.ts";

import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { createPurchaseOrderSchema } from "./purchase-order.schema.js";
import {
  createPurchaseOrderHandler,
  getAllPurchaseOrdersHandler,
  getPurchaseOrderByIdHandler,
  receivePurchaseOrderHandler,
} from "./purchase-order.controller.js";

export const purchaseOrderRouter = Router();

purchaseOrderRouter.post(
  "/",
  validate(createPurchaseOrderSchema),
  Authenticated,
  Authorize("ADMIN"),
  createPurchaseOrderHandler
);

// Lectura: el handoff dice "probablemente sí, solo lectura" para EMPLOYE.
// Lo dejo abierto a ambos roles — avisame si preferís restringirlo también a ADMIN.
purchaseOrderRouter.get("/", Authenticated, getAllPurchaseOrdersHandler);
purchaseOrderRouter.get("/:id", Authenticated, getPurchaseOrderByIdHandler);

purchaseOrderRouter.patch(
  "/:id/receive",
  Authenticated,
  Authorize("ADMIN"),
  receivePurchaseOrderHandler
);

// hilo de comentarios de la orden: solo admins
purchaseOrderRouter.get("/:id/comments", Authenticated, Authorize("ADMIN"), getCommentsHandler("order"));
purchaseOrderRouter.post(
  "/:id/comments",
  validate(createCommentSchema),
  Authenticated,
  Authorize("ADMIN"),
  addCommentHandler("order")
);

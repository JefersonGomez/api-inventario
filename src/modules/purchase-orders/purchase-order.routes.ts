// purchase-order.router.ts
import { Router } from "express";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { createCommentSchema } from "../comments/comment.schema.ts";
import { getCommentsHandler, addCommentHandler } from "../comments/comment.controller.ts";

import { Can,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import {
  cancelPurchaseOrderSchema, closePurchaseOrderSchema, createPurchaseOrderSchema, purchaseOrderListQuerySchema, receivePurchaseOrderSchema,
} from "./purchase-order.schema.js";
import {
  createPurchaseOrderHandler,
  getAllPurchaseOrdersHandler,
  getPurchaseOrderByIdHandler,
  receivePurchaseOrderHandler,
  sendPurchaseOrderEmailHandler,
  cancelPurchaseOrderHandler,
  closePurchaseOrderHandler,
} from "./purchase-order.controller.js";

export const purchaseOrderRouter = Router();

purchaseOrderRouter.post(
  "/",
  validate(createPurchaseOrderSchema),
  Authenticated,
  Can("purchases.manage"),
  createPurchaseOrderHandler
);

// Lectura: el handoff dice "probablemente sí, solo lectura" para EMPLOYE.
// Lo dejo abierto a ambos roles — avisame si preferís restringirlo también a ADMIN.
purchaseOrderRouter.get("/", validateQuery(purchaseOrderListQuerySchema), Authenticated, Can("purchases.manage"), getAllPurchaseOrdersHandler);
purchaseOrderRouter.get("/:id", Authenticated, Can("purchases.manage"), getPurchaseOrderByIdHandler);

// recibir (todo o una parte), cancelar (sin nada recibido) y cerrar (con algo recibido: lo pendiente se cancela)
purchaseOrderRouter.patch(
  "/:id/receive",
  validate(receivePurchaseOrderSchema),
  Authenticated,
  Can("purchases.manage"),
  receivePurchaseOrderHandler
);
purchaseOrderRouter.post("/:id/cancel", validate(cancelPurchaseOrderSchema), Authenticated, Can("purchases.manage"), cancelPurchaseOrderHandler);
purchaseOrderRouter.post("/:id/close", validate(closePurchaseOrderSchema), Authenticated, Can("purchases.manage"), closePurchaseOrderHandler);

// envía (o reenvía) la orden al email del proveedor
purchaseOrderRouter.post("/:id/send-email", Authenticated, Can("purchases.manage"), sendPurchaseOrderEmailHandler);

// hilo de comentarios de la orden: solo admins
purchaseOrderRouter.get("/:id/comments", Authenticated, Can("purchases.manage"), getCommentsHandler("order"));
purchaseOrderRouter.post(
  "/:id/comments",
  validate(createCommentSchema),
  Authenticated,
  Can("purchases.manage"),
  addCommentHandler("order")
);

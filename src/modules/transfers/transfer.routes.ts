import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { createTransferSchema, receiveTransferSchema, transferListQuerySchema } from "./transfer.service.ts"
import {
  cancelTransferHandler, createTransferHandler, getTransferHandler, listTransfersHandler, receiveTransferHandler,
} from "./transfer.controller.ts"

// Todo con stock.move; además se valida que la persona trabaje en el origen (enviar) o el destino (recibir)
export const router = Router()

router.get("/", validateQuery(transferListQuerySchema), Authenticated, Can("stock.move"), listTransfersHandler)
router.get("/:id", Authenticated, Can("stock.move"), getTransferHandler)
router.post("/", validate(createTransferSchema), Authenticated, Can("stock.move"), createTransferHandler)
router.post("/:id/receive", validate(receiveTransferSchema), Authenticated, Can("stock.move"), receiveTransferHandler)
router.post("/:id/cancel", Authenticated, Can("stock.move"), cancelTransferHandler)

import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { countListQuerySchema, createCountSchema, saveCountSchema } from "./stock-count.service.ts"
import {
  cancelCountHandler, closeCountHandler, createCountHandler, getCountHandler, listCountsHandler, saveCountHandler,
} from "./stock-count.controller.ts"

// Todo con stock.move y en una ubicación donde la persona trabaja
export const router = Router()

router.get("/", validateQuery(countListQuerySchema), Authenticated, Can("stock.move"), listCountsHandler)
router.get("/:id", Authenticated, Can("stock.move"), getCountHandler)
router.post("/", validate(createCountSchema), Authenticated, Can("stock.move"), createCountHandler)
router.put("/:id/items", validate(saveCountSchema), Authenticated, Can("stock.move"), saveCountHandler)
router.post("/:id/close", Authenticated, Can("stock.move"), closeCountHandler)
router.post("/:id/cancel", Authenticated, Can("stock.move"), cancelCountHandler)

import { Router } from "express";
import { Can,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { createMovementController,getMovementsController } from "./movements.controller.ts";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { CreateMovementsSchema, movementListQuerySchema } from "./movements.schema.ts";
export const router = Router()

router.post("/", validate(CreateMovementsSchema),Authenticated, Can("stock.move"), createMovementController)
router.get('/', validateQuery(movementListQuerySchema), Authenticated, getMovementsController);
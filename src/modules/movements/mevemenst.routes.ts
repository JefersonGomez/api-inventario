import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { createMovementController,getMovementsController } from "./movements.controller.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { CreateMovementsSchema } from "./movements.schema.ts";
export const router = Router()

router.post("/", validate(CreateMovementsSchema),Authenticated, Authorize("ADMIN", "EMPLOYEE"), createMovementController)
router.get('/',Authenticated,getMovementsController);
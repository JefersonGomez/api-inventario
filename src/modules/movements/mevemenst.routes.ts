import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { createMovementController,getMovementsController } from "./movements.controller.ts";
export const router = Router()

router.post("/", Authenticated, Authorize("ADMIN", "EMPLOYEE"), createMovementController)
router.get('/',Authenticated,getMovementsController);
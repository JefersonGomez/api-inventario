import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { getAllUsersController, toggleUserActiveHandler } from "./userGestion.controller.ts"

export const router = Router()

router.get("/", Authenticated, Authorize("ADMIN"), getAllUsersController)
router.patch("/:id/toggle-active", Authenticated, Authorize("ADMIN"), toggleUserActiveHandler)
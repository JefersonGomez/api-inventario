import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { getAllUsersController, toggleUserActiveHandler } from "./userGestion.controller.ts"
import { validateQuery } from "../../middlewares/validate.middleware.ts"
import { catalogQuerySchema } from "../../shared/pagination.ts"

export const router = Router()

router.get("/", validateQuery(catalogQuerySchema), Authenticated, Authorize("ADMIN"), getAllUsersController)
router.patch("/:id/toggle-active", Authenticated, Authorize("ADMIN"), toggleUserActiveHandler)
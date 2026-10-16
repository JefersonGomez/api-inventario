import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { getAllUsersController, toggleUserActiveHandler, permissionCatalogHandler, updateUserAccessHandler } from "./userGestion.controller.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { updateAccessSchema } from "./userGestion.schema.ts"
import { catalogQuerySchema } from "../../shared/pagination.ts"
import { assignPinHandler, cashCodeTeamHandler } from "../users/pin.controller.ts"
import { assignPinSchema } from "../users/pin.service.ts"

export const router = Router()

router.get("/", validateQuery(catalogQuerySchema), Authenticated, Can("users.manage"), getAllUsersController)
router.get("/permissions", Authenticated, Can("users.manage"), permissionCatalogHandler)
router.patch("/:id/toggle-active", Authenticated, Can("users.manage"), toggleUserActiveHandler)
// códigos de caja: el admin los asigna a cualquiera, el encargado a los cajeros (lo valida el service)
router.get("/cash-codes", Authenticated, cashCodeTeamHandler)
router.post("/:id/pin", validate(assignPinSchema), Authenticated, assignPinHandler)
router.patch("/:id/access", validate(updateAccessSchema), Authenticated, Can("users.manage"), updateUserAccessHandler)
import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { getAllUsersController, toggleUserActiveHandler, permissionCatalogHandler, updateUserAccessHandler } from "./userGestion.controller.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { updateAccessSchema } from "./userGestion.schema.ts"
import { catalogQuerySchema } from "../../shared/pagination.ts"
import { generatePinHandler } from "../users/pin.controller.ts"

export const router = Router()

router.get("/", validateQuery(catalogQuerySchema), Authenticated, Can("users.manage"), getAllUsersController)
router.get("/permissions", Authenticated, Can("users.manage"), permissionCatalogHandler)
router.patch("/:id/toggle-active", Authenticated, Can("users.manage"), toggleUserActiveHandler)
// generar el código de caja de alguien: el admin para cualquiera, el encargado para cajeros (lo valida el service)
router.post("/:id/pin", Authenticated, generatePinHandler)
router.patch("/:id/access", validate(updateAccessSchema), Authenticated, Can("users.manage"), updateUserAccessHandler)
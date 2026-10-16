import { Router } from "express"
import { Authenticated } from "../../middlewares/authenticate.middleware.ts"
import { upload, validateImageContent } from "../../shared/utils/upload.ts"
import { getProfileController, updateAvatarController, updateProfileController } from "./user.controller.ts"

import { validate } from "../../middlewares/validate.middleware.ts"
import { changePasswordSchema,updateProfileSchema } from "./user.schema.ts"
import { changePasswordController } from "./user.controller.ts"
import { setPinSchema } from "./pin.service.ts"
import { deletePinHandler, setPinHandler } from "./pin.controller.ts"

export const router = Router()

router.get("/me", Authenticated, getProfileController)
router.post("/me/avatar", Authenticated, upload.single("avatar"), validateImageContent, updateAvatarController)
router.put("/me/password", validate(changePasswordSchema), Authenticated, changePasswordController)
router.put("/me", validate(updateProfileSchema), Authenticated, updateProfileController)
// PIN de autorización de la empresa activa (encargados: descuentos y anulaciones en la caja)
router.put("/me/pin", validate(setPinSchema), Authenticated, setPinHandler)
router.delete("/me/pin", Authenticated, deletePinHandler)
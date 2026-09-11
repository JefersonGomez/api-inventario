import { Router } from "express"
import { Authenticated } from "../../middlewares/authenticate.middleware.ts"
import { upload } from "../../shared/utils/upload.ts"
import { getProfileController, updateAvatarController } from "./user.controller.ts"

import { validate } from "../../middlewares/validate.middleware.ts"
import { changePasswordSchema } from "./user.schema.ts"
import { changePasswordController } from "./user.controller.ts"

export const router = Router()

router.get("/me", Authenticated, getProfileController)
router.post("/me/avatar", Authenticated, upload.single("avatar"), updateAvatarController)
router.put("/me/password", Authenticated, validate(changePasswordSchema), changePasswordController)
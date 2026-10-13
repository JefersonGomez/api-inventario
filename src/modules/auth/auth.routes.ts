import { Router } from "express";
import {RegisterController,LoginController,refreshController,logoutCotroller,meHandler,switchCompanyHandler} from "./auth.controller.ts"
import { validate } from "../../middlewares/validate.middleware.ts";
import { registerSchema,loginSchema,switchCompanySchema } from "./auth.schema.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { loginLimiter, sensitiveLimiter } from "../../middlewares/rate-limit.middleware.ts";
export const router = Router()

router.post("/register", sensitiveLimiter, validate(registerSchema), RegisterController)
router.post("/login", loginLimiter, validate(loginSchema), LoginController)
router.post("/refresh", refreshController);
router.post("/logout", logoutCotroller);
router.get("/me", Authenticated, meHandler);
// cambia la empresa activa: devuelve tokens nuevos para esa empresa
router.post("/switch-company", validate(switchCompanySchema), Authenticated, switchCompanyHandler);


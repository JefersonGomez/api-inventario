import { Router } from "express";
import {RegisterController,LoginController,refreshController,logoutCotroller,meHandler,switchCompanyHandler,demoInfoHandler,demoLoginHandler,registrationStatusHandler} from "./auth.controller.ts"
import { validate } from "../../middlewares/validate.middleware.ts";
import { registerSchema,loginSchema,switchCompanySchema } from "./auth.schema.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { loginLimiter, sensitiveLimiter } from "../../middlewares/rate-limit.middleware.ts";
export const router = Router()

// GET dice si se pueden crear cuentas nuevas (la página de registro avisa si está cerrado)
router.get("/registration", registrationStatusHandler)
router.post("/register", sensitiveLimiter, validate(registerSchema), RegisterController)
router.post("/login", loginLimiter, validate(loginSchema), LoginController)
// demo pública: GET dice si está activa (y los códigos de caja que muestra); POST entra como ADMIN o CASHIER
router.get("/demo", demoInfoHandler)
router.post("/demo", sensitiveLimiter, demoLoginHandler)
router.post("/refresh", refreshController);
router.post("/logout", logoutCotroller);
router.get("/me", Authenticated, meHandler);
// cambia la empresa activa: devuelve tokens nuevos para esa empresa
router.post("/switch-company", validate(switchCompanySchema), Authenticated, switchCompanyHandler);


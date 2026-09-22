import { Router } from "express";
import {RegisterController,LoginController,refreshController,logoutCotroller,meHandler} from "./auth.controller.ts"
import { validate } from "../../middlewares/validate.middleware.ts";
import { registerSchema,loginSchema } from "./auth.schema.ts";
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";
export const router = Router()

router.post("/register",validate(registerSchema),RegisterController)
router.post("/login",validate(loginSchema),LoginController)
router.post("/refresh", refreshController);
router.post("/logout", logoutCotroller);
router.get("/me", Authenticated, meHandler);


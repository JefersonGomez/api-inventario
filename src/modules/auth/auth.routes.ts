import { Router } from "express";
import {RegisterController,LoginController} from "./auth.controller.ts"
import { validate } from "../../middlewares/validate.middleware.ts";
import { registerSchema,loginSchema } from "./auth.schema.ts";
export const router = Router()

router.post("/register",validate(registerSchema),RegisterController)
router.post("/login",validate(loginSchema),LoginController)



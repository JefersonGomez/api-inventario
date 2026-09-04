import { Router } from "express";
import {RegisterController,LoginController,MeController} from "./auth.controller.ts"
import { Authenticated } from "../../middlewares/authenticate.middleware.ts";

export const router = Router()

router.post("/register",RegisterController)
router.post("/login",LoginController)
router.get("/me", Authenticated, MeController)


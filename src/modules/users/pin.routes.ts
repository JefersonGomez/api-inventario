import { Router } from "express"
import { Authenticated } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { pinLimiter } from "../../middlewares/rate-limit.middleware.ts"
import { authorizeSchema } from "./pin.service.ts"
import { authorizeHandler } from "./pin.controller.ts"

// POST /authorizations { pin, permission, reason? }: la caja pide que alguien con permiso autorice
export const authorizationRouter = Router()
authorizationRouter.post("/", validate(authorizeSchema), Authenticated, pinLimiter, authorizeHandler)

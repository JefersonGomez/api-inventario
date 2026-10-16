import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { locationSchema, updateLocationSchema } from "./location.service.ts"
import { createLocationHandler, listLocationsHandler, updateLocationHandler } from "./location.controller.ts"

// Ver: cualquiera (las suyas). Crear, editar y desactivar: quien administra la empresa.
export const router = Router()

router.get("/", Authenticated, listLocationsHandler)
router.post("/", validate(locationSchema), Authenticated, Can("company.manage"), createLocationHandler)
router.patch("/:id", validate(updateLocationSchema), Authenticated, Can("company.manage"), updateLocationHandler)

import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { productGroupSchema } from "./product-group.schema.ts"
import {
  createProductGroupController,
  deleteProductGroupController,
  getProductGroupsController,
  updateProductGroupController,
} from "./product-group.controller.ts"

// Productos base (agrupan variantes). Mismos permisos que los productos: leer todos, cambiar ADMIN.
export const router = Router()

router.get("/", Authenticated, getProductGroupsController)
router.post("/", validate(productGroupSchema), Authenticated, Authorize("ADMIN"), createProductGroupController)
router.put("/:id", validate(productGroupSchema), Authenticated, Authorize("ADMIN"), updateProductGroupController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteProductGroupController)

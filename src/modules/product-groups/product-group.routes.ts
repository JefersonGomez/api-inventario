import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { productGroupSchema } from "./product-group.schema.ts"
import {
  createProductGroupController,
  deleteProductGroupController,
  getProductGroupsController,
  updateProductGroupController,
} from "./product-group.controller.ts"

// Productos base (agrupan variantes). Mismos permisos que los productos: leer todos, cambiar products.manage.
export const router = Router()

router.get("/", Authenticated, getProductGroupsController)
router.post("/", validate(productGroupSchema), Authenticated, Can("products.manage"), createProductGroupController)
router.put("/:id", validate(productGroupSchema), Authenticated, Can("products.manage"), updateProductGroupController)
router.delete("/:id", Authenticated, Can("products.manage"), deleteProductGroupController)

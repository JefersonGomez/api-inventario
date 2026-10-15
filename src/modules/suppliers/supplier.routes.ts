import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { catalogQuerySchema } from "../../shared/pagination.ts"
import { supplierSchema } from "./supplier.schema.ts"
import {
  createSupplierController,
  getAllSuppliersController,
  getSupplierByIdController,
  updateSupplierController,
  deleteSupplierController,
} from "./supplier.controller.ts"

export const router = Router()

router.get("/", validateQuery(catalogQuerySchema), Authenticated, getAllSuppliersController)
router.get("/:id", Authenticated, getSupplierByIdController)
router.post("/", validate(supplierSchema), Authenticated, Authorize("ADMIN"), createSupplierController)
router.put("/:id", validate(supplierSchema), Authenticated, Authorize("ADMIN"), updateSupplierController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteSupplierController)
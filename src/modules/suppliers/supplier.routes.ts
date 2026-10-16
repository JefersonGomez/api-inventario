import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
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
router.post("/", validate(supplierSchema), Authenticated, Can("suppliers.manage"), createSupplierController)
router.put("/:id", validate(supplierSchema), Authenticated, Can("suppliers.manage"), updateSupplierController)
router.delete("/:id", Authenticated, Can("suppliers.manage"), deleteSupplierController)
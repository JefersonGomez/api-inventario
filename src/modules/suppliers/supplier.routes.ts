import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { supplierSchema } from "./supplier.schema.ts"
import {
  createSupplierController,
  getAllSuppliersController,
  getSupplierByIdController,
  updateSupplierController,
  deleteSupplierController,
} from "./supplier.controller.ts"

export const router = Router()

router.get("/", Authenticated, getAllSuppliersController)
router.get("/:id", Authenticated, getSupplierByIdController)
router.post("/", validate(supplierSchema), Authenticated, Authorize("ADMIN"), createSupplierController)
router.put("/:id", validate(supplierSchema), Authenticated, Authorize("ADMIN"), updateSupplierController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteSupplierController)
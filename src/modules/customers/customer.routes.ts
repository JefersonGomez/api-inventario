import { Router } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { catalogQuerySchema } from "../../shared/pagination.ts"
import { customerSchema } from "./customer.schema.ts"
import {
  createCustomerController,
  deleteCustomerController,
  getCustomerByIdController,
  getCustomersController,
  updateCustomerController,
} from "./customer.controller.ts"

// Registrar y editar: customers.manage (también el cajero, los necesita al vender); borrar: customers.delete
export const router = Router()

router.get("/", validateQuery(catalogQuerySchema), Authenticated, getCustomersController)
router.get("/:id", Authenticated, getCustomerByIdController)
router.post("/", validate(customerSchema), Authenticated, Can("customers.manage"), createCustomerController)
router.put("/:id", validate(customerSchema), Authenticated, Can("customers.manage"), updateCustomerController)
router.delete("/:id", Authenticated, Can("customers.delete"), deleteCustomerController)

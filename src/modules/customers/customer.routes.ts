import { Router } from "express"
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import { customerSchema } from "./customer.schema.ts"
import {
  createCustomerController,
  deleteCustomerController,
  getCustomerByIdController,
  getCustomersController,
  updateCustomerController,
} from "./customer.controller.ts"

// Cualquier miembro registra y edita clientes (el cajero los necesita al vender); borrar, solo ADMIN
export const router = Router()

router.get("/", Authenticated, getCustomersController)
router.get("/:id", Authenticated, getCustomerByIdController)
router.post("/", validate(customerSchema), Authenticated, Authorize("ADMIN", "EMPLOYE"), createCustomerController)
router.put("/:id", validate(customerSchema), Authenticated, Authorize("ADMIN", "EMPLOYE"), updateCustomerController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteCustomerController)

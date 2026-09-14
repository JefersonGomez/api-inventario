import { Router } from "express";
import { CreateProductController,getAllProductsController,getProductByIdController,updateProductController,deleteProductController,getProductByBarcodeController } from "./products.controller.ts";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { productsSchemaCreate,productsSchemaUpdate } from "./products.schema.ts";
export const router = Router()

router.post("/",validate(productsSchemaCreate),Authenticated, Authorize("ADMIN"),CreateProductController)
router.get("/",Authenticated,getAllProductsController)

router.get("/barcode/:code", Authenticated, getProductByBarcodeController);


router.get("/:id",Authenticated,getProductByIdController)
router.put("/:id",validate(productsSchemaUpdate),Authenticated, Authorize("ADMIN"),updateProductController)
router.delete("/:id",Authenticated, Authorize("ADMIN"),deleteProductController)



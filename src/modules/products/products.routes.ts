import { Router } from "express";
import { CreateProductController,getProductPriceHistoryHandler,getAllProductsController,getProductByIdController,updateProductController,deleteProductController,getProductByBarcodeController,
    getExpiringSoonProductsHandler
} from "./products.controller.ts";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { productsSchemaCreate,productsSchemaUpdate } from "./products.schema.ts";
export const router = Router()

router.post("/",validate(productsSchemaCreate),Authenticated, Authorize("ADMIN"),CreateProductController)
router.get("/",Authenticated,getAllProductsController)

// rutas fijas antes de "/:id", o Express las toma como un id
router.get("/expiring-soon", Authenticated, getExpiringSoonProductsHandler);
router.get("/barcode/:code", Authenticated, getProductByBarcodeController);


router.get("/:id",Authenticated,getProductByIdController)
router.put("/:id",validate(productsSchemaUpdate),Authenticated, Authorize("ADMIN"),updateProductController)
router.delete("/:id",Authenticated, Authorize("ADMIN"),deleteProductController)

router.get("/:id/price-history", Authenticated, getProductPriceHistoryHandler);

import { Router } from "express";
import { CreateProductController,getProductPriceHistoryHandler,getAllProductsController,getProductByIdController,updateProductController,deleteProductController,getProductByBarcodeController,
    getExpiringSoonProductsHandler, importProductsHandler
} from "./products.controller.ts";
import Express from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { productsSchemaCreate,productsSchemaUpdate,productsImportSchema,productListQuerySchema } from "./products.schema.ts";
export const router = Router()

router.post("/",validate(productsSchemaCreate),Authenticated, Authorize("ADMIN"),CreateProductController)
router.get("/", validateQuery(productListQuerySchema), Authenticated, getAllProductsController)

// importación desde Excel: hasta 2000 filas, por eso su propio límite de tamaño (el global es 100 KB)
router.post("/import", Express.json({ limit: "2mb" }), validate(productsImportSchema), Authenticated, Authorize("ADMIN"), importProductsHandler)

// rutas fijas antes de "/:id", o Express las toma como un id
router.get("/expiring-soon", Authenticated, getExpiringSoonProductsHandler);
router.get("/barcode/:code", Authenticated, getProductByBarcodeController);


router.get("/:id",Authenticated,getProductByIdController)
router.put("/:id",validate(productsSchemaUpdate),Authenticated, Authorize("ADMIN"),updateProductController)
router.delete("/:id",Authenticated, Authorize("ADMIN"),deleteProductController)

router.get("/:id/price-history", Authenticated, getProductPriceHistoryHandler);

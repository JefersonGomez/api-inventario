import { Router } from "express";
import { CreateProductController,getProductPriceHistoryHandler,getAllProductsController,getProductByIdController,updateProductController,deleteProductController,getProductByBarcodeController,
    getExpiringSoonProductsHandler, importProductsHandler, generateBarcodesHandler, aiMapHandler, aiQuotaHandler
} from "./products.controller.ts";
import Express from "express";
import { Can,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts";
import { productsSchemaCreate,productsSchemaUpdate,productsImportSchema,productListQuerySchema } from "./products.schema.ts";
import { generateBarcodesSchema } from "./barcodes.service.ts";
import { aiMapSchema } from "./ai-import.service.ts";
export const router = Router()

router.post("/",validate(productsSchemaCreate),Authenticated, Can("products.manage"),CreateProductController)
router.get("/", validateQuery(productListQuerySchema), Authenticated, getAllProductsController)

// importación desde Excel: hasta 2000 filas, por eso su propio límite de tamaño (el global es 100 KB)
router.post("/import", Express.json({ limit: "2mb" }), validate(productsImportSchema), Authenticated, Can("products.manage"), importProductsHandler)

// rutas fijas antes de "/:id", o Express las toma como un id
// importar con ayuda de la IA: solo una muestra de filas; devuelve fila de encabezados y columnas
router.post("/import/ai-map", validate(aiMapSchema), Authenticated, Can("products.manage"), aiMapHandler);
router.get("/import/ai-quota", Authenticated, Can("products.manage"), aiQuotaHandler);
// genera EAN-13 internos para los productos sin código (todos o los indicados)
router.post("/barcodes", validate(generateBarcodesSchema), Authenticated, Can("products.manage"), generateBarcodesHandler);
router.get("/expiring-soon", Authenticated, getExpiringSoonProductsHandler);
router.get("/barcode/:code", Authenticated, getProductByBarcodeController);


router.get("/:id",Authenticated,getProductByIdController)
router.put("/:id",validate(productsSchemaUpdate),Authenticated, Can("products.manage"),updateProductController)
router.delete("/:id",Authenticated, Can("products.manage"),deleteProductController)

router.get("/:id/price-history", Authenticated, getProductPriceHistoryHandler);

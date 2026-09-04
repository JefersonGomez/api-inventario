import { Router } from "express";
import { CreateProductController,getAllProductsController,getProductByIdController,updateCategoryController,deleteProductController } from "./products.controller.ts";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";

export const router = Router()
router.post("/",Authenticated, Authorize("ADMIN"),CreateProductController)
router.get("/",getAllProductsController)
router.get("/:id",getProductByIdController)
router.put("/:id",Authenticated, Authorize("ADMIN"),updateCategoryController)
router.delete("/:id",Authenticated, Authorize("ADMIN"),deleteProductController)
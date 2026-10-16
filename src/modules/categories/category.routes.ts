import { Router } from "express";
import { Can,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { CreateCategoryController,getAllCategoriesController,GetCategoryByIdController,updateCategoryController,deleteCategoryCotroller } from "./category.controller.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { categorySchema } from "./category.schema.ts";
export const router = Router()

router.get("/:id", Authenticated, GetCategoryByIdController)
router.get("/", Authenticated, getAllCategoriesController)

router.post("/", validate(categorySchema),Authenticated, Can("products.manage"), CreateCategoryController)
router.put("/:id",validate(categorySchema),Authenticated, Can("products.manage"), updateCategoryController)
router.delete("/:id", Authenticated, Can("products.manage"), deleteCategoryCotroller)


import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { CreateCategoryController,getAllCategoriesController,GetCategoryByIdController,updateCategoryController,deleteCategoryCotroller } from "./category.controller.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { categorySchema } from "./category.schema.ts";
export const router = Router()

router.get("/:id", Authenticated, GetCategoryByIdController)
router.get("/", Authenticated, getAllCategoriesController)

router.post("/", validate(categorySchema),Authenticated, Authorize("ADMIN"), CreateCategoryController)
router.put("/:id",validate(categorySchema),Authenticated, Authorize("ADMIN"), updateCategoryController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteCategoryCotroller)
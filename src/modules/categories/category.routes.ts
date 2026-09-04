import { Router } from "express";
import { Authorize,Authenticated } from "../../middlewares/authenticate.middleware.ts";
import { CreateCategoryController,getAllCategoriesController,GetCategoryByIdController,updateCategoryController,deleteCategoryCotroller } from "./category.controller.ts";

export const router = Router()

router.get("/:id", Authenticated, GetCategoryByIdController)
router.get("/", Authenticated, getAllCategoriesController)

router.post("/", Authenticated, Authorize("ADMIN"), CreateCategoryController)
router.put("/:id", Authenticated, Authorize("ADMIN"), updateCategoryController)
router.delete("/:id", Authenticated, Authorize("ADMIN"), deleteCategoryCotroller)
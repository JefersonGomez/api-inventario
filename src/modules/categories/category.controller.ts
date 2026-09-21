import type { Request, Response } from "express";
import {
  createCategory,
  updateCategory,
  getAllCategories,
  GetCategoryById,
  deleteCategory,
} from "./category.service.ts";

export async function CreateCategoryController(req: Request, res: Response) {
  try {
    const { name, description } = req.body;
    const create = await createCategory(name, description);
    return res.status(201).json(create);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}

export async function getAllCategoriesController(_req: Request, res: Response) {
  try {
    const categories = await getAllCategories();
    return res.status(200).json(categories);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}

export async function GetCategoryByIdController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const category = await GetCategoryById(id);
    return res.status(200).json(category);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}

export async function updateCategoryController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // Permite que el cuerpo envíe 'name' o 'nameCategory'
    const { name, nameCategory, description } = req.body;
    const categoryName = name || nameCategory;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const update = await updateCategory(id, categoryName, description,req.user!.id);
    return res.status(200).json(update);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}

export async function deleteCategoryCotroller(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const categoryDeleted = await deleteCategory(id,req.user!.id);
    return res.status(200).json(categoryDeleted);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}
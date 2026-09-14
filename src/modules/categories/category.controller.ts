import type { Request, Response } from "express";
import {
  createCategory,
  updateCategory,
  getAllCategories,
  GetCategoryById,
  deleteCategory,
} from "./category.service.ts";
import { error } from "node:console";

export async function CreateCategoryController(req: Request, res: Response) {
  try {
    const {nameCategory,description} = req.body.name;
    const create = await createCategory(nameCategory,description);
    if (create) {
      res.status(201).json(create);
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function getAllCategoriesController(req: Request, res: Response) {
  try {
    const categories = await getAllCategories();
    res.status(200).json(categories);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function GetCategoryByIdController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // ✅ Validar que 'id' exista y sea de tipo string
    if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }

    // Ahora TypeScript sabe con certeza que 'id' es de tipo string
    const category = await GetCategoryById(id);
    return res.status(200).json(category);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function updateCategoryController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }
    const update = await updateCategory(id, name, description);
    res.status(200).json(update);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function deleteCategoryCotroller(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }
    const deleteCategorys = await deleteCategory(id);
    res.status(200).json(deleteCategorys);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

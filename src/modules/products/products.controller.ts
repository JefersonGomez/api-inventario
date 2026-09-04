import type { Request, Response } from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} from "./products.service.ts";

export async function CreateProductController(req: Request, res: Response) {
  try {
    const { sku, name, description, price, stock, minStock, categoryId } =
      req.body;

    const create = await createProduct(
      sku,
      name,
      description,
      price,
      stock,
      minStock,
      categoryId,
    );
    res.status(201).json(create);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getAllProductsController(req: Request, res: Response) {
  try {
    const getProducts = await getAllProducts();
    res.status(200).json(getProducts);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getProductByIdController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }

    const getProduct = await getProductById(id);

    res.status(200).json(getProduct);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function updateCategoryController(req: Request, res: Response) {
  try {
   const { id } = req.params;
    const {name, description, price, minStock, categoryId } = req.body;
    if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }

    const update = await updateProduct(id,name,description,price,minStock,categoryId)
   
    res.status(200).json(update)


  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}


export async function deleteProductController(req: Request, res: Response) {
    try{

       const { id } = req.params;
         if (!id || typeof id !== "string") {
      return res
        .status(400)
        .json({ message: "El ID es requerido y debe ser un texto" });
    }
    const deleteP = await deleteProduct(id)

    res.status(200).json(deleteP)



    }catch(error){
         res.status(400).json({ error: (error as Error).message });

    }


}
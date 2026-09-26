import type { Request, Response } from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  getProductByBarcode, // Importar la nueva función
  getProductPriceHistory,
  getExpiringSoonProducts
} from "./products.service.ts";

export async function CreateProductController(req: Request, res: Response) {
  try {
    const { sku, barcode, name, description, price, stock, minStock, categoryId,expirationDate } = req.body;

    const created = await createProduct(
      sku,
      barcode,
      name,
      description,
      price,
      stock,
      minStock,
      categoryId,
      expirationDate
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getAllProductsController(req: Request, res: Response) {
  try {
    const products = await getAllProducts();
    res.status(200).json(products);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getProductByIdController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const product = await getProductById(id);
    res.status(200).json(product);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function updateProductController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, barcode, description, price, minStock, categoryId,expirationDate } = req.body;
    
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }

    const updated = await updateProduct(id, name, barcode, description, price, minStock, categoryId,req.user!.id,expirationDate);
    res.status(200).json(updated);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function deleteProductController(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }
    
    const deleted = await deleteProduct(id,req.user!.id);
    res.status(200).json(deleted);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getProductByBarcodeController(req: Request, res: Response) {
  try {
    const { code } = req.params;
     if (!code || typeof code !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" });
    }
    const product = await getProductByBarcode(code);
    
    if (!product) {
      return res.status(404).json({ message: "Producto no encontrado con ese código" });
    }
    
    return res.json(product);
  } catch (error) {
    return res.status(500).json({ message: "Error interno del servidor" });
  }
}

// product.controller.ts — agregar
export async function getProductPriceHistoryHandler(
  req: Request<{ id: string }>,
  res: Response
) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const history = await getProductPriceHistory(id);
    res.json(history);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export async function getExpiringSoonProductsHandler(req: Request, res: Response) {
  try {
    const { days } = req.query;
    const daysAhead = days ? Number(days) : 7;
    const products = await getExpiringSoonProducts(daysAhead);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}
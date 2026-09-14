import { z } from "zod";

export const productsSchemaCreate = z.object({
  sku: z.string().min(1, "El SKU del producto es requerido"),
  barcode: z.string().optional(), // Nuevo campo opcional
  name: z.string().min(1, "El nombre del producto es requerido"),
  description: z.string().optional(),
  price: z.number().positive("El precio debe ser positivo"),
  stock: z.number().nonnegative("El stock no puede ser negativo"),
  minStock: z.number().nonnegative("El stock mínimo no puede ser negativo"),
  categoryId: z.string().uuid("El ID de categoría debe ser un UUID válido"),
});

export const productsSchemaUpdate = z.object({
  name: z.string().min(1, "El nombre del producto es requerido"),
  barcode: z.string().optional(), // Nuevo campo opcional
  description: z.string().optional(),
  price: z.number().positive("El precio debe ser positivo"),
  minStock: z.number().nonnegative("El stock mínimo no puede ser negativo"),
  categoryId: z.string().uuid("El ID de categoría debe ser un UUID válido"),
});
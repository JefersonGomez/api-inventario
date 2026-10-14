import { z } from "zod";

export const productsSchemaCreate = z.object({
  sku: z.string().min(1, "El SKU del producto es requerido"),
  barcode: z.string().optional(), // Nuevo campo opcional
  name: z.string().min(1, "El nombre del producto es requerido"),
  description: z.string().optional(),
  price: z.number().positive("El precio debe ser positivo"),
  cost: z.number().nonnegative("El costo no puede ser negativo").nullable().optional(),
  stock: z.number().nonnegative("El stock no puede ser negativo"),
  minStock: z.number().nonnegative("El stock mínimo no puede ser negativo"),
  categoryId: z.string().uuid("El ID de categoría debe ser un UUID válido"),
  expirationDate: z.coerce.date().optional(),
  supplierId: z.string().uuid("El ID de proveedor debe ser un UUID válido").nullable().optional(),
});

export const productsSchemaUpdate = z.object({
  name: z.string().min(1, "El nombre del producto es requerido"),
  barcode: z.string().optional(), // Nuevo campo opcional
  description: z.string().optional(),
  price: z.number().positive("El precio debe ser positivo"),
  cost: z.number().nonnegative("El costo no puede ser negativo").nullable().optional(),
  minStock: z.number().nonnegative("El stock mínimo no puede ser negativo"),
  categoryId: z.string().uuid("El ID de categoría debe ser un UUID válido"),
  expirationDate: z.coerce.date().optional(),
  supplierId: z.string().uuid("El ID de proveedor debe ser un UUID válido").nullable().optional(),
});
// Importación desde Excel: el frontend manda las filas ya leídas; las reglas de negocio las valida el service
const importRow = z.object({
  rowNumber: z.number().int().positive(),
  sku: z.string().max(200).optional(),
  name: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  price: z.number().optional(),
  cost: z.number().optional(),
  stock: z.number().optional(),
  minStock: z.number().optional(),
  barcode: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  supplier: z.string().max(200).optional(),
  expirationDate: z.string().max(40).optional(),
});

// arreglos en bloque elegidos en la vista previa (sin opciones = modo estricto: todo es error)
const importOptions = z.object({
  defaultCategory: z.string().trim().max(100).optional(),
  generateSku: z.boolean().optional(),
  pendingPrice: z.boolean().optional(),
  fixNumbers: z.boolean().optional(),
  ignoreInvalidDate: z.boolean().optional(),
  dropConflictingBarcode: z.boolean().optional(),
  skipRepeated: z.boolean().optional(),
  updateExisting: z.boolean().optional(),
});

export const productsImportSchema = z.object({
  rows: z.array(importRow).min(1, "El archivo no tiene filas").max(2000, "Máximo 2000 filas por importación"),
  dryRun: z.boolean(),
  options: importOptions.optional(),
});

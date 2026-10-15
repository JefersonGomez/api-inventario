import { z } from "zod";
import { stockSchema } from "../../shared/units.ts";
import { pageQuery, queryFlag } from "../../shared/pagination.ts";

const unit = z.enum(["UNIT", "KG", "G", "L", "ML", "M", "CM", "M2"]);
const taxRate = z.enum(["EXEMPT", "RATE_1", "RATE_2", "RATE_4", "RATE_13"]);
// CABYS: 13 dígitos; vacío = sin código (se completa antes de facturar)
const cabys = z.string().trim().regex(/^\d{13}$/, "El código CABYS tiene 13 dígitos").nullable().optional();
// variante: producto base + un valor por cada atributo del grupo ({ "Talla": "M" }); null = producto suelto
const groupId = z.string().uuid().nullable().optional();
const attributes = z.record(z.string().trim().min(1).max(40), z.string().trim().max(60)).nullable().optional();

export const productsSchemaCreate = z.object({
  sku: z.string().min(1, "El SKU del producto es requerido"),
  barcode: z.string().optional(), // Nuevo campo opcional
  name: z.string().min(1, "El nombre del producto es requerido"),
  description: z.string().optional(),
  price: z.number().positive("El precio debe ser positivo"),
  cost: z.number().nonnegative("El costo no puede ser negativo").nullable().optional(),
  stock: stockSchema,
  minStock: stockSchema,
  unit: unit.optional(),
  taxRate: taxRate.optional(),
  cabys,
  groupId,
  attributes,
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
  minStock: stockSchema,
  unit: unit.optional(),
  taxRate: taxRate.optional(),
  cabys,
  groupId,
  attributes,
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
  unit: z.string().max(40).optional(),
  taxRate: z.string().max(40).optional(),
  cabys: z.string().max(40).optional(),
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
  ignoreBadFiscal: z.boolean().optional(),
});

export const productsImportSchema = z.object({
  rows: z.array(importRow).min(1, "El archivo no tiene filas").max(2000, "Máximo 2000 filas por importación"),
  dryRun: z.boolean(),
  options: importOptions.optional(),
});

// GET /products: flat = productos (selector, variantes de un grupo); grouped = productos base con su
// resumen primero y después los productos sueltos (tabla de Productos)
export const productListQuerySchema = z.object({
  ...pageQuery,
  view: z.enum(["flat", "grouped"]).default("flat"),
  categoryId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  pending: queryFlag, // importados "Por completar"
  lowStock: queryFlag, // stock <= mínimo
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

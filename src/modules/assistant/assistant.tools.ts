// src/modules/assistant/assistant.tools.ts
import { Type } from "@google/genai";
import * as reportsService from "../reports/report.service.ts";
import * as productService from "../products/products.service.ts";
import * as movementsService from "../movements/movements.service.ts";
export const toolDeclarations = [
  {
    name: "getLowStockReport",
    description: "Devuelve la lista de productos cuyo stock actual está en o por debajo de su stock mínimo definido. Útil para preguntas sobre qué productos están por agotarse o necesitan reabastecimiento.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getInventoryValueReport",
    description: "Devuelve el valor total del inventario (stock × precio de todos los productos activos) y la cantidad total de productos. Útil para preguntas sobre cuánto dinero hay invertido en inventario.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getAllProducts",
    description: "Devuelve la lista completa de productos activos, con su categoría, precio, stock actual y stock mínimo. Útil para preguntas generales sobre qué productos existen o sus datos puntuales.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getMovements",
    description: "Devuelve el historial de movimientos de stock (entradas, salidas, ajustes), opcionalmente filtrado por un producto específico. Útil para preguntas sobre qué pasó con el stock de un producto en particular, o el historial reciente en general.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        productId: {
          type: Type.STRING,
          description: "El UUID del producto para filtrar los movimientos. Si no se especifica, devuelve todos los movimientos recientes.",
        },
      },
    },
  },
];

export const toolExecutors: Record<string, (args: any) => Promise<unknown>> = {
  getLowStockReport: () => reportsService.getLowStockReport(),
  getInventoryValueReport: () => reportsService.getInventoryValueReport(),
  getAllProducts: () => productService.getAllProducts(),
  getMovements: (args) => movementsService.getMovements(args?.productId),
};
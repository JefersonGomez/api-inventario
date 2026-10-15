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
    description: "Devuelve el valor total del inventario a COSTO (stock × costo promedio de compra; es lo que hay invertido), el valor a precio de venta como referencia (retailValue), la cantidad de productos y cuántos productos con stock no tienen costo cargado (esos no suman al total). Útil para preguntas sobre cuánto dinero hay invertido en inventario.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "searchProducts",
    description: "Busca productos activos por nombre, SKU, código de barras, categoría o producto base (variantes). Devuelve hasta 100 coincidencias, con su categoría, precio de venta (incluye IVA), costo (puede ser null), unidad, stock actual y stock mínimo, y el total de coincidencias. Sin texto de búsqueda devuelve los primeros 100 por nombre. Útil para preguntas sobre productos puntuales.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Texto a buscar (nombre, SKU, código de barras, categoría o producto base). Opcional.",
        },
      },
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
  // ponytail: tope de 100 resultados por consulta; si hiciera falta más, agregar paginación a la herramienta
  searchProducts: (args) =>
    productService.listProducts({ view: "flat", page: 1, pageSize: 100, ...(args?.query && { q: String(args.query) }) }),
  getMovements: (args) =>
    movementsService.listMovements({ page: 1, pageSize: 100, ...(args?.productId && { productId: String(args.productId) }) }),
};
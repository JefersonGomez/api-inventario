// src/modules/assistant/assistant.tools.ts
import { Type } from "@google/genai";
import * as reportsService from "../reports/report.service.ts";
import * as productService from "../products/products.service.ts";
import * as movementsService from "../movements/movements.service.ts";
import { getSalesReport } from "../reports/sales-report.service.ts";
import { listReceivables } from "../receivables/receivables.service.ts";

const ymd = (d: Date) => d.toLocaleDateString("sv");
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
  {
    name: "getSalesReport",
    description: "Reporte de ventas de un período (fechas AAAA-MM-DD, máximo un año): venta neta (vendido menos devoluciones), vendido, devoluciones, tiquetes y tiquete promedio, el período anterior del mismo largo para comparar, ventas por medio de pago (CREDIT = lo que se fue a cuotas), por cajero, los 15 productos más vendidos (neto, por monto), 15 productos con stock que no se vendieron y, si la persona puede ver costos, la ganancia (profit). Montos con IVA. Útil para '¿cuánto vendí?', '¿cómo vamos contra el mes pasado?', '¿qué es lo que más se vende?', '¿qué no se vende?'. Si no dan fechas, usa el mes en curso.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        from: { type: Type.STRING, description: "Fecha inicial AAAA-MM-DD. Opcional (por defecto el 1 del mes en curso)." },
        to: { type: Type.STRING, description: "Fecha final AAAA-MM-DD. Opcional (por defecto hoy)." },
      },
    },
  },
  {
    name: "getReceivables",
    description: "Cuentas por cobrar: clientes con crédito o con saldo pendiente, con su límite, saldo, monto vencido, cantidad de cuotas vencidas y próxima cuota, más los totales. Útil para '¿quién me debe?', '¿quién está atrasado?', '¿cuánto tengo por cobrar?'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        overdueOnly: { type: Type.BOOLEAN, description: "true = solo los que tienen cuotas vencidas." },
      },
    },
  },
];

// ctx: permisos de quien pregunta (la ganancia de ventas solo con costs.view)
export const toolExecutors: Record<string, (args: any, ctx: { permissions: string[] }) => Promise<unknown>> = {
  getLowStockReport: () => reportsService.getLowStockReport(),
  getInventoryValueReport: () => reportsService.getInventoryValueReport(),
  // ponytail: tope de 100 resultados por consulta; si hiciera falta más, agregar paginación a la herramienta
  searchProducts: (args) =>
    productService.listProducts({ view: "flat", page: 1, pageSize: 100, ...(args?.query && { q: String(args.query) }) }),
  getMovements: (args) =>
    movementsService.listMovements({ page: 1, pageSize: 100, ...(args?.productId && { productId: String(args.productId) }) }),
  // recortado: el reporte completo trae 100 productos y 50 sin ventas, demasiado para el modelo
  getSalesReport: async (args, ctx) => {
    const now = new Date();
    const from = typeof args?.from === "string" ? args.from : ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    const to = typeof args?.to === "string" ? args.to : ymd(now);
    const r = await getSalesReport({ from, to }, ctx);
    return {
      from: r.from, to: r.to, totals: r.totals, previous: r.previous, byMethod: r.byMethod,
      byCashier: r.byCashier.map(({ name, net, tickets }) => ({ name, net, tickets })),
      topProducts: r.products.slice(0, 15), notSold: r.notSold.slice(0, 15).map(({ name, stock }) => ({ name, stock })),
      discounts: r.discounts.total, ...(r.profit && { profit: r.profit }),
    };
  },
  getReceivables: (args) => listReceivables({ page: 1, pageSize: 50, q: undefined, ...(args?.overdueOnly === true && { overdue: "1" as const }) }),
};
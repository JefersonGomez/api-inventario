import { prisma } from "../../config/database.ts"

export async function getLowStockReport() {
  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    include: { category: true }
  });

  const lowStockProducts = allProducts.filter(
    // Number(): comparar dos Decimal con <= compara su texto ("10.000" <= "5.000" es verdadero)
    (product) => Number(product.stock) <= Number(product.minStock)
  );

  return lowStockProducts;
}

export async function getMovementsReport(from?: string, to?: string) {
  const whereClause: { createdAt?: { gte?: Date; lte?: Date } } = {};

  if (from || to) {
    whereClause.createdAt = {};
    if (from) whereClause.createdAt.gte = new Date(from);
    if (to) whereClause.createdAt.lte = new Date(to);
  }

  const movements = await prisma.stockMovement.findMany({
    where: whereClause,
    include: {
      product: true,
      user: {
        select: { id: true, name: true, email: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return movements;
}

// Valor del inventario A COSTO (stock × costo promedio), que es lo que espera un contador.
// Los productos con stock y sin costo conocido no suman: se cuentan en `productsWithoutCost`
// para avisarlo en pantalla, en vez de inventarles un valor.
// `retailValue` (stock × precio de venta) queda como referencia de lo que valdría vendido.
export async function getInventoryValueReport() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { stock: true, price: true, cost: true },
  });

  let totalValue = 0;
  let retailValue = 0;
  let productsWithoutCost = 0;

  for (const product of products) {
    const stock = Number(product.stock);
    retailValue += stock * Number(product.price);
    if (product.cost !== null) totalValue += stock * Number(product.cost);
    else if (stock > 0) productsWithoutCost++;
  }

  return {
    totalValue: Number(totalValue.toFixed(2)),
    retailValue: Number(retailValue.toFixed(2)),
    totalProducts: products.length,
    productsWithoutCost,
  };
}

export async function getInventoryValueBreakdown(daysThreshold = 60) {
  const cutoffDate = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000);

  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, sku: true, stock: true, cost: true },
  });

  // Traemos, en una sola consulta, los productos que SÍ tuvieron
  // movimiento reciente (evita un findMany por producto, un problema N+1)
  const recentMovements = await prisma.stockMovement.findMany({
    where: { createdAt: { gte: cutoffDate } },
    select: { productId: true },
    distinct: ["productId"],
  });
  const activeProductIds = new Set(recentMovements.map((m) => m.productId));

  let activeValue = 0;
  let immobilizedValue = 0;
  let productsWithoutCost = 0;
  const immobilizedProducts: { id: string; name: string; sku: string; value: number; hasCost: boolean }[] = [];

  for (const product of allProducts) {
    const hasCost = product.cost !== null;
    const stock = Number(product.stock);
    if (!hasCost && stock > 0) productsWithoutCost++;
    const value = hasCost ? stock * Number(product.cost) : 0;

    if (activeProductIds.has(product.id)) {
      activeValue += value;
    } else {
      immobilizedValue += value;
      // sin stock no hay capital atrapado; sin costo se lista igual (con valor "—") para que se complete
      if (stock > 0) {
        immobilizedProducts.push({ id: product.id, name: product.name, sku: product.sku, value: Number(value.toFixed(2)), hasCost });
      }
    }
  }

  // Los productos con más capital inmovilizado primero — son los
  // que más vale la pena revisar
  immobilizedProducts.sort((a, b) => b.value - a.value);

  return {
    daysThreshold,
    totalValue: Number((activeValue + immobilizedValue).toFixed(2)),
    activeValue: Number(activeValue.toFixed(2)),
    immobilizedValue: Number(immobilizedValue.toFixed(2)),
    productsWithoutCost,
    immobilizedProducts,
  };
}

export async function getStockForecast(velocityWindowDays = 30, alertThresholdDays = 14) {
  const cutoffDate = new Date(Date.now() - velocityWindowDays * 24 * 60 * 60 * 1000);

  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, sku: true, stock: true },
  });

  // Suma de unidades vendidas (OUT) por producto, en una sola consulta
  const salesByProduct = await prisma.stockMovement.groupBy({
    by: ["productId"],
    where: {
      type: "OUT",
      createdAt: { gte: cutoffDate },
    },
    _sum: { quantity: true },
  });

  const salesMap = new Map(
    salesByProduct.map((s) => [s.productId, Number(s._sum.quantity ?? 0)])
  );

  const forecast = products
    .map((product) => {
      const totalSold = salesMap.get(product.id) ?? 0;

      // Sin ventas recientes: no hay velocidad, no se puede predecir nada
      if (totalSold === 0) return null;

      const dailyVelocity = totalSold / velocityWindowDays;
      const daysRemaining = Number(product.stock) / dailyVelocity;

      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        currentStock: Number(product.stock),
        dailyVelocity: Number(dailyVelocity.toFixed(2)),
        daysRemaining: Number(daysRemaining.toFixed(1)),
        willRunOutSoon: daysRemaining <= alertThresholdDays,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    // los más urgentes primero (menos días restantes)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    velocityWindowDays,
    alertThresholdDays,
    forecast, // TODOS los productos con velocidad calculable, ordenados por urgencia
    urgent: forecast.filter((f) => f.willRunOutSoon), // solo los que disparan alerta
  };
}
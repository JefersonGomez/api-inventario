import { prisma } from "../../config/database.ts"

export async function getLowStockReport() {
  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    include: { category: true }
  });

  const lowStockProducts = allProducts.filter(
    (product) => product.stock <= product.minStock
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
        select: { id: true, name: true, email: true, role: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return movements;
}

export async function getInventoryValueReport() {
  const allProducts = await prisma.product.findMany();

  let totalValue = 0;

  for (const product of allProducts) {
    totalValue += product.stock * Number(product.price);
  }

  return {
    totalValue: Number(totalValue.toFixed(2)),
    totalProducts: allProducts.length
  };
}

export async function getInventoryValueBreakdown(daysThreshold = 60) {
  const cutoffDate = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000);

  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, sku: true, stock: true, price: true },
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
  const immobilizedProducts: { id: string; name: string; sku: string; value: number }[] = [];

  for (const product of allProducts) {
    const value = product.stock * Number(product.price);

    if (activeProductIds.has(product.id)) {
      activeValue += value;
    } else {
      immobilizedValue += value;
      immobilizedProducts.push({
        id: product.id,
        name: product.name,
        sku: product.sku,
        value: Number(value.toFixed(2)),
      });
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
    salesByProduct.map((s) => [s.productId, s._sum.quantity ?? 0])
  );

  const forecast = products
    .map((product) => {
      const totalSold = salesMap.get(product.id) ?? 0;

      // Sin ventas recientes: no hay velocidad, no se puede predecir nada
      if (totalSold === 0) return null;

      const dailyVelocity = totalSold / velocityWindowDays;
      const daysRemaining = product.stock / dailyVelocity;

      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        currentStock: product.stock,
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
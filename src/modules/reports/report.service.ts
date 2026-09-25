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
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
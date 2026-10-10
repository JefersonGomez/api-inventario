import { prisma } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { getCompany } from "../company/company.service.ts";
// null = sin proveedor; undefined = no tocar
async function assertSupplierExists(supplierId: string | null | undefined) {
  if (!supplierId) return;
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new Error("El proveedor indicado no existe");
}

const withSupplier = { category: true, supplier: { select: { id: true, name: true } } };

export async function createProduct(
  sku: string,
  barcode: string | undefined,
  name: string,
  description: string | undefined,
  price: number,
  stock: number,
  minStock: number,
  categoryId: string,
  expirationDate?: Date, // ← nuevo parámetro, al final para no romper el orden existente
  supplierId?: string | null
) {
  await assertSupplierExists(supplierId);
  const { maxProducts } = (await getCompany()).limits;
  if (maxProducts !== null && (await prisma.product.count({ where: { deletedAt: null } })) >= maxProducts) {
    throw new Error(`Tu plan permite ${maxProducts} productos. Mejora tu plan para agregar más.`);
  }
  const existProduct = await prisma.product.findFirst({
    where: { sku: sku, deletedAt: null },
  });

  if (existProduct) {
    throw new Error("El producto ya existe en el sistema");
  }

  const existCategory = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null }
  });

  if (!existCategory) {
    throw new Error("La categoría es inválida");
  }

  const newProduct = await prisma.product.create({
    data: {
      companyId: currentCompanyId(),
      sku: sku,
      barcode: barcode || null,
      name: name,
      description: description ?? null,
      price: price,
      stock: stock,
      minStock: minStock,
      categoryId: categoryId,
      expirationDate: expirationDate ?? null, // ← nuevo
      supplierId: supplierId ?? null,
    },
    include: withSupplier,
  });

  return newProduct;
}

export async function getAllProducts() {
  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null }, // ← nuevo
    include: withSupplier
  });
  return allProducts;
}

export async function getProductById(idProduct: string) {
  const existProduct = await prisma.product.findFirst({
    where: { id: idProduct, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: withSupplier
  });

  if (!existProduct) {
    throw new Error("No se encontró el producto");
  }
  return existProduct;
}

export async function getProductByBarcode(code: string) {
  const product = await prisma.product.findFirst({
    where: { barcode: code, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: withSupplier
  });
  return product;
}

export async function updateProduct(
  id: string,
  name: string,
  barcode: string | undefined,
  description: string | undefined,
  price: number,
  minStock: number,
  categoryId: string,
  userId: string,
  expirationDate?: Date, // ← nuevo parámetro, al final
  supplierId?: string | null
) {
  await assertSupplierExists(supplierId);
  const existCategory = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null }
  });

  if (!existCategory) {
    throw new Error("Categoría ingresada inválida");
  }

  const updatedProduct = await prisma.product.update({
    where: { id: id },
    data: {
      name: name,
      barcode: barcode || null,
      description: description ?? null,
      price: price,
      minStock: minStock,
      categoryId: categoryId,
      expirationDate: expirationDate ?? null, // ← nuevo
      ...(supplierId !== undefined && { supplierId }),
    },
    include: withSupplier,
  });

  await logAudit(userId, "UPDATE", "Product", id, {
    name, barcode, description, price, minStock, categoryId, expirationDate, supplierId
  });

  return updatedProduct;
}

export async function deleteProduct(id: string,userId:string) {
  // antes: prisma.product.delete(...)
  const deletedProduct = await prisma.product.update({
    where: { id: id },
    data: { deletedAt: new Date() }
  });

  await logAudit(userId,"DELETE","Product",id)
  return deletedProduct;
}


export async function getProductPriceHistory(productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, name: true, price: true, updatedAt: true },
  });

  if (!product) {
    throw new Error("No se encontró el producto");
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "Product",
      entityId: productId,
      action: "UPDATE",
    },
    orderBy: { createdAt: "asc" },
    select: { changes: true, createdAt: true },
  });

  // Extraemos solo los cambios de precio, ignorando updates donde
  // el price no cambió (ej. alguien solo editó el nombre)
  const history = logs
    .map((log) => {
      const changes = log.changes as { price?: number } | null;
      if (changes?.price === undefined) return null;
      return { price: changes.price, date: log.createdAt };
    })
    .filter((entry): entry is { price: number; date: Date } => entry !== null);

  // Agregamos el precio actual al final, como el punto más reciente
  history.push({ price: Number(product.price), date: product.updatedAt });

  return {
    productId: product.id,
    productName: product.name,
    currentPrice: Number(product.price),
    history,
  };
}


export async function getExpiringSoonProducts(daysAhead = 7) {
  const now = new Date();
  const limit = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return prisma.product.findMany({
    where: {
      deletedAt: null,
      expirationDate: { not: null, gte: now, lte: limit },
    },
    orderBy: { expirationDate: "asc" },
  });
}
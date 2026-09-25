import { prisma } from "../../config/database.ts";
import { logAudit } from "../audit/audit.service.ts";
export async function createProduct(
  sku: string,
  barcode: string | undefined,
  name: string,
  description: string | undefined,
  price: number,
  stock: number,
  minStock: number,
  categoryId: string,
) {
  const existProduct = await prisma.product.findFirst({
    where: { sku: sku, deletedAt: null }, 
  });

  if (existProduct) {
    throw new Error("El producto ya existe en el sistema");
  }

  const existCategory = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null } // ← nuevo: no crear productos en categorías "eliminadas"
  });

  if (!existCategory) {
    throw new Error("La categoría es inválida");
  }

  const newProduct = await prisma.product.create({
    data: {
      sku: sku,
      barcode: barcode || null,
      name: name,
      description: description ?? null,
      price: price,
      stock: stock,
      minStock: minStock,
      categoryId: categoryId,
    }
  });

  return newProduct;
}

export async function getAllProducts() {
  const allProducts = await prisma.product.findMany({
    where: { deletedAt: null }, // ← nuevo
    include: { category: true }
  });
  return allProducts;
}

export async function getProductById(idProduct: string) {
  const existProduct = await prisma.product.findFirst({
    where: { id: idProduct, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: { category: true }
  });

  if (!existProduct) {
    throw new Error("No se encontró el producto");
  }
  return existProduct;
}

export async function getProductByBarcode(code: string) {
  const product = await prisma.product.findFirst({
    where: { barcode: code, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: { category: true }
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
  userId:string
) {
  const existCategory = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null } // ← nuevo
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
      categoryId: categoryId
    }
  });

  await logAudit (userId,"UPDATE","Product",id,{ name, barcode, description, price, minStock, categoryId})

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
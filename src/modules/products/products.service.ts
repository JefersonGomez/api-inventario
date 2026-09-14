import { prisma } from "../../config/database.ts";

export async function createProduct(
  sku: string,
  barcode: string | undefined, // Puede ser opcional si no se escanea al crear
  name: string,
  description: string | undefined,
  price: number,
  stock: number,
  minStock: number,
  categoryId: string,
) {
  const existProduct = await prisma.product.findUnique({
    where: { sku: sku }
  });

  if (existProduct) {
    throw new Error("El producto ya existe en el sistema");
  }

  const existCategory = await prisma.category.findUnique({
    where: { id: categoryId }
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
    include: { category: true }
  });
  return allProducts;
}

export async function getProductById(idProduct: string) {
  const existProduct = await prisma.product.findUnique({
    where: { id: idProduct },
    include: { category: true }
  });

  if (!existProduct) {
    throw new Error("No se encontró el producto");
  }
  return existProduct;
}

// NUEVA FUNCIÓN AGREGADA
export async function getProductByBarcode(code: string) {
  const product = await prisma.product.findUnique({
    where: { barcode: code },
    include: { category: true }
  });
  return product; // Retorna null si no existe, lo manejamos en el controller
}

export async function updateProduct(
  id: string,
  name: string,
  barcode: string | undefined,
  description: string | undefined,
  price: number,
  minStock: number,
  categoryId: string
) {
  const existCategory = await prisma.category.findUnique({
    where: { id: categoryId }
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

  return updatedProduct;
}

export async function deleteProduct(id: string) {
  const deletedProduct = await prisma.product.delete({
    where: { id: id }
  });
  return deletedProduct;
}
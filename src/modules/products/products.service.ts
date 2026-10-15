import { prisma } from "../../config/database.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { getCompany } from "../company/company.service.ts";
import { createMovement } from "../movements/movements.service.ts";
import { assertQuantityForUnit } from "../../shared/units.ts";
import type { z } from "zod";
import type { productsSchemaCreate, productsSchemaUpdate } from "./products.schema.ts";
import { normalizeVariant } from "../product-groups/product-group.service.ts";
// null = sin proveedor; undefined = no tocar
async function assertSupplierExists(supplierId: string | null | undefined) {
  if (!supplierId) return;
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new Error("El proveedor indicado no existe");
}

const withSupplier = {
  category: true,
  supplier: { select: { id: true, name: true } },
  group: { select: { id: true, name: true, attributeNames: true } },
};

export type ProductCreateInput = z.infer<typeof productsSchemaCreate>;
export type ProductUpdateInput = z.infer<typeof productsSchemaUpdate>;

export async function createProduct(input: ProductCreateInput, userId: string) {
  const { sku, barcode, name, description, price, stock, minStock, categoryId, expirationDate, supplierId, cost } = input;
  const unit = input.unit ?? "UNIT";
  assertQuantityForUnit(stock, unit, "El stock");
  assertQuantityForUnit(minStock, unit, "El stock mínimo");
  await assertSupplierExists(supplierId);
  const variant = await normalizeVariant(input.groupId, input.attributes);
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

  // el producto nace con stock 0 y el inicial entra como movimiento (origen INITIAL): así
  // toda unidad en stock tiene un movimiento que la explica
  const { id } = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        companyId: currentCompanyId(),
        sku: sku,
        barcode: barcode || null,
        name: name,
        description: description ?? null,
        price: price,
        unit,
        taxRate: input.taxRate ?? "RATE_13",
        cabys: input.cabys || null,
        groupId: variant.groupId,
        ...(variant.attributes && { attributes: variant.attributes }),
        stock: 0,
        minStock: minStock,
        categoryId: categoryId,
        expirationDate: expirationDate ?? null,
        supplierId: supplierId ?? null,
        cost: cost ?? null,
      },
      select: { id: true },
    });
    if (stock > 0) {
      await createMovement(created.id, userId, "IN", stock, undefined, tx, { source: "INITIAL" });
    }
    return created;
  });

  return prisma.product.findUniqueOrThrow({ where: { id }, include: withSupplier });
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

export async function updateProduct(id: string, input: ProductUpdateInput, userId: string) {
  const { name, barcode, description, price, minStock, categoryId, expirationDate, supplierId, cost, unit, taxRate, cabys } = input;
  // groupId omitido = no tocar la variante; null = deja de ser variante
  const variant = input.groupId === undefined ? undefined : await normalizeVariant(input.groupId, input.attributes, id);
  await assertSupplierExists(supplierId);
  const existCategory = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null }
  });

  if (!existCategory) {
    throw new Error("Categoría ingresada inválida");
  }

  const current = await prisma.product.findFirst({ where: { id, deletedAt: null }, select: { stock: true, unit: true } });
  if (!current) throw new Error("No se encontró el producto");
  const finalUnit = unit ?? current.unit;
  // pasar a "por unidad" con stock fraccionado (p. ej. 2,5 kg) dejaría un stock imposible
  assertQuantityForUnit(Number(current.stock), finalUnit, "El stock actual");
  assertQuantityForUnit(minStock, finalUnit, "El stock mínimo");

  // sin include: un update con varias relaciones incluidas corre como transacción interna y adapter-pg
  // las carga en paralelo sobre la misma conexión (aviso de pg). Se lee completo al final.
  await prisma.product.update({
    where: { id: id },
    data: {
      name: name,
      barcode: barcode || null,
      description: description ?? null,
      price: price,
      pendingReview: false, // al editarlo (con precio válido, lo exige el schema) deja de estar "Por completar"
      minStock: minStock,
      categoryId: categoryId,
      expirationDate: expirationDate ?? null,
      ...(supplierId !== undefined && { supplierId }),
      ...(cost !== undefined && { cost }),
      ...(unit !== undefined && { unit }),
      ...(taxRate !== undefined && { taxRate }),
      ...(cabys !== undefined && { cabys: cabys || null }),
      ...(variant && { groupId: variant.groupId, attributes: variant.attributes ?? Prisma.DbNull }),
    },
  });

  await logAudit(userId, "UPDATE", "Product", id, {
    name, barcode, description, price, minStock, categoryId, expirationDate, supplierId, cost, unit, taxRate, cabys,
    ...(variant && { groupId: variant.groupId, attributes: variant.attributes }),
  });

  return prisma.product.findUniqueOrThrow({ where: { id }, include: withSupplier });
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
import { prisma, prismaRoot } from "../../config/database.ts";
import { contains, pageArgs, pageResult } from "../../shared/pagination.ts";
import type { ProductListQuery } from "./products.schema.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { getCompany } from "../company/company.service.ts";
import { createMovement } from "../movements/movements.service.ts";
import { resolveLocation } from "../locations/location.service.ts";
import { lowStockProductIds, scopedStock, withScopedStock } from "../locations/stock-scope.ts";
import { inTransitByProduct } from "../transfers/transfer.service.ts";
import { locationScope } from "../../shared/tenant.ts";
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

  const location = await resolveLocation(input.locationId);
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
      await createMovement(created.id, userId, "IN", stock, undefined, tx, { source: "INITIAL", locationId: location.id });
    } else {
      await tx.productStock.create({ data: { companyId: currentCompanyId(), productId: created.id, locationId: location.id } });
    }
    return created;
  });

  return prisma.product.findUniqueOrThrow({ where: { id }, include: withSupplier });
}

// Filtros de producto compartidos por las dos vistas. lowStock compara dos columnas (stock <= minStock);
// con una ubicación elegida, lowIds = los que están bajo su mínimo ahí.
function productWhere(f: ProductListQuery, lowIds: string[] | null = null): Prisma.ProductWhereInput {
  return {
    deletedAt: null,
    ...(f.categoryId && { categoryId: f.categoryId }),
    ...(f.supplierId && { supplierId: f.supplierId }),
    ...(f.groupId && { groupId: f.groupId }),
    ...(f.pending !== undefined && { pendingReview: f.pending }),
    ...(f.lowStock && (lowIds ? { id: { in: lowIds } } : { stock: { lte: prismaRoot.product.fields.minStock } })),
    ...(f.q && {
      OR: [
        { name: contains(f.q) },
        { sku: contains(f.q) },
        { barcode: f.q },
        { category: { name: contains(f.q) } },
        { group: { name: contains(f.q) } },
      ],
    }),
  };
}

const hasFilters = (f: ProductListQuery) =>
  Boolean(f.q || f.categoryId || f.supplierId || f.pending !== undefined || f.lowStock);

// Con una ubicación elegida (o si la persona solo trabaja en algunas), el stock que se ve es el de ahí
export async function listProducts(f: ProductListQuery) {
  const scope = locationScope();
  const lowIds = f.lowStock && scope ? await lowStockProductIds(scope) : null;
  if (f.view === "grouped" && !f.groupId) return listProductsGrouped(f, scope, lowIds);
  const where = productWhere(f, lowIds);
  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, include: withSupplier, orderBy: [{ name: "asc" }, { sku: "asc" }], ...pageArgs(f) }),
  ]);
  return pageResult(await withScopedStock(items, scope), total, f);
}

// Vista de la tabla: productos base (con el resumen de sus variantes) y después productos sueltos,
// paginados como una sola lista. Las variantes de cada grupo se piden aparte al desplegarlo.
async function listProductsGrouped(f: ProductListQuery, scope: string[] | null, lowIds: string[] | null) {
  const filtered = hasFilters(f);
  const groupWhere: Prisma.ProductGroupWhereInput = {
    deletedAt: null,
    // con filtros, un producto base entra si alguna variante cumple (o si la búsqueda coincide con su nombre)
    ...(filtered && {
      OR: [
        { products: { some: productWhere(f, lowIds) } },
        ...(f.q && !(f.categoryId || f.supplierId || f.pending !== undefined || f.lowStock) ? [{ name: contains(f.q) }] : []),
      ],
    }),
  };
  const looseWhere: Prisma.ProductWhereInput = { ...productWhere(f, lowIds), groupId: null };

  const [groupTotal, looseTotal, pendingCount] = await Promise.all([
    prisma.productGroup.count({ where: groupWhere }),
    prisma.product.count({ where: looseWhere }),
    prisma.product.count({ where: { deletedAt: null, pendingReview: true } }),
  ]);
  const { skip, take } = pageArgs(f);
  const groups = skip < groupTotal
    ? await prisma.productGroup.findMany({ where: groupWhere, orderBy: { name: "asc" }, skip, take })
    : [];
  const looseTake = take - groups.length;
  const loose = looseTake > 0
    ? await prisma.product.findMany({
        where: looseWhere,
        include: withSupplier,
        orderBy: [{ name: "asc" }, { sku: "asc" }],
        skip: Math.max(0, skip - groupTotal),
        take: looseTake,
      })
    : [];

  const summaries = await summarizeGroups(groups.map((g) => g.id), scope);
  const items = [
    ...groups.map((g) => ({ kind: "group" as const, ...g, ...summaries.get(g.id) })),
    ...(await withScopedStock(loose, scope)).map((p) => ({ kind: "product" as const, ...p })),
  ];
  return { ...pageResult(items, groupTotal + looseTotal, f), pendingCount };
}

// Resumen de las variantes de cada producto base: cuántas, rango de precios (sin las "Por
// completar"), stock total (si todas usan la misma unidad) y cuántas están bajo el mínimo
async function summarizeGroups(ids: string[], scope: string[] | null = null) {
  const empty = { variantCount: 0, minPrice: null as number | null, maxPrice: null as number | null, totalStock: null as number | null, unit: null as string | null, lowCount: 0 };
  const out = new Map(ids.map((id) => [id, { ...empty }]));
  if (!ids.length) return out;
  const base = { groupId: { in: ids }, deletedAt: null };
  const [all, priced, low, units] = await Promise.all([
    prisma.product.groupBy({ by: ["groupId"], where: base, _count: { _all: true }, _sum: { stock: true } }),
    prisma.product.groupBy({ by: ["groupId"], where: { ...base, pendingReview: false }, _min: { price: true }, _max: { price: true } }),
    prisma.product.groupBy({ by: ["groupId"], where: { ...base, stock: { lte: prismaRoot.product.fields.minStock } }, _count: { _all: true } }),
    prisma.product.groupBy({ by: ["groupId", "unit"], where: base }),
  ]);
  for (const r of all) Object.assign(out.get(r.groupId!)!, { variantCount: r._count._all, totalStock: Number(r._sum.stock ?? 0) });
  for (const r of priced) Object.assign(out.get(r.groupId!)!, { minPrice: Number(r._min.price), maxPrice: Number(r._max.price) });
  for (const r of low) out.get(r.groupId!)!.lowCount = r._count._all;
  const unitsBy = new Map<string, string[]>();
  for (const r of units) unitsBy.set(r.groupId!, [...(unitsBy.get(r.groupId!) ?? []), r.unit]);
  // con ubicación elegida: stock y "bajo mínimo" de las variantes en esa ubicación
  if (scope) {
    const variants = await prisma.product.findMany({ where: base, select: { id: true, groupId: true, minStock: true } });
    const stock = await scopedStock(variants.map((v) => v.id), scope);
    for (const s of out.values()) Object.assign(s, { totalStock: 0, lowCount: 0 });
    for (const v of variants) {
      const s = out.get(v.groupId!)!;
      const qty = stock.get(v.id) ?? 0;
      s.totalStock! += qty;
      if (qty <= Number(v.minStock)) s.lowCount++;
    }
  }
  for (const [id, list] of unitsBy) {
    const s = out.get(id)!;
    if (list.length === 1) s.unit = list[0]!;
    else s.totalStock = null; // kg + unidades no se suman
  }
  return out;
}

export async function getProductById(idProduct: string) {
  const existProduct = await prisma.product.findFirst({
    where: { id: idProduct, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: withSupplier
  });

  if (!existProduct) {
    throw new Error("No se encontró el producto");
  }
  // desglose por ubicación (solo las que ve la persona); leído aparte: nada de include múltiple en una consulta
  const scope = locationScope();
  const stocks = await prisma.productStock.findMany({
    where: { productId: idProduct, ...(scope && { locationId: { in: scope } }) },
    select: { quantity: true, location: { select: { id: true, name: true, type: true } } },
    orderBy: { location: { name: "asc" } },
  });
  const [scoped] = await withScopedStock([existProduct], scope);
  const inTransit = (await inTransitByProduct([idProduct])).get(idProduct) ?? 0; // enviado y sin recibir
  return { ...scoped!, stocks, inTransit };
}

export async function getProductByBarcode(code: string) {
  const product = await prisma.product.findFirst({
    where: { barcode: code, deletedAt: null }, // ← nuevo, y findUnique → findFirst
    include: withSupplier
  });
  return product && (await withScopedStock([product], locationScope()))[0]!;
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
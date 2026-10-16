// Importación masiva de productos desde Excel. El frontend lee el archivo y manda las filas ya
// separadas en columnas; acá se valida todo (nunca se confía en el cliente) y se guarda en una sola
// transacción. Con dryRun = true no escribe nada: devuelve la vista previa.
//
// Para que el cliente no tenga que corregir el Excel celda por celda, los problemas comunes se
// resuelven EN BLOQUE con opciones (el frontend manda las recomendadas ya marcadas):
//   - sin categoría → categoría por defecto      - sin SKU → código generado (IMP-0001…)
//   - sin precio o precio inválido → se importa "Por completar" (nunca se inventa un precio)
//   - cantidades con decimales/negativas, costo inválido → se corrigen o se dejan vacíos
//   - fecha inválida → sin fecha                  - código de barras en conflicto → sin código
//   - SKU repetido en el archivo → se usa el primero
//   - SKU que ya existe → se salta (o se actualiza el producto, si se elige; el stock nunca se toca)
//   - unidad / IVA / CABYS no reconocidos → por unidad, 13 %, sin CABYS
// El stock inicial de los productos nuevos entra como movimiento (origen INITIAL).
// Lo que no tiene arreglo (sin nombre, textos demasiado largos, límite del plan) queda como error.
// Sin opciones (llamada directa a la API) todo se trata como error: el modo estricto.
import { resolveLocation } from "../locations/location.service.ts";
import { prisma } from "../../config/database.ts";
import { currentCompanyId } from "../../shared/tenant.ts";
import { logAudit } from "../audit/audit.service.ts";
import { getCompany } from "../company/company.service.ts";
import { parseTaxRate, parseUnit, roundQty } from "../../shared/units.ts";
import type { TaxRate, UnitOfMeasure } from "../../generated/prisma/enums.ts";

export type ImportRow = {
  rowNumber: number;
  sku?: string | undefined;
  name?: string | undefined;
  category?: string | undefined;
  price?: number | undefined;
  cost?: number | undefined;
  stock?: number | undefined;
  minStock?: number | undefined;
  barcode?: string | undefined;
  description?: string | undefined;
  supplier?: string | undefined;
  expirationDate?: string | undefined; // AAAA-MM-DD
  unit?: string | undefined; // texto libre: "kg", "Unidad", "litros"...
  taxRate?: string | undefined; // "13", "13 %", "Exento", "0.04"...
  cabys?: string | undefined;
};

export type ImportOptions = {
  defaultCategory: string;
  generateSku: boolean;
  pendingPrice: boolean;
  fixNumbers: boolean;
  ignoreInvalidDate: boolean;
  dropConflictingBarcode: boolean;
  skipRepeated: boolean;
  updateExisting: boolean;
  ignoreBadFiscal: boolean;
};

export const STRICT_OPTIONS: ImportOptions = {
  defaultCategory: "",
  generateSku: false,
  pendingPrice: false,
  fixNumbers: false,
  ignoreInvalidDate: false,
  dropConflictingBarcode: false,
  skipRepeated: false,
  updateExisting: false,
  ignoreBadFiscal: false,
};

// tipos de problema que se muestran agrupados en la vista previa (con su cantidad de filas)
type Issue =
  | "missingCategory" | "missingSku" | "missingPrice" | "badNumbers" | "invalidDate"
  | "barcodeConflict" | "repeatedSku" | "existing" | "badFiscal";

type Status = "create" | "update" | "skip" | "error";

type RowResult = {
  rowNumber: number;
  sku: string;
  name: string;
  status: Status;
  pending: boolean; // quedará "Por completar"
  fixes: string[]; // arreglos aplicados a esta fila
  errors: string[]; // lo que impide importarla
};

type Prepared = {
  row: ImportRow;
  result: RowResult;
  data: {
    sku: string; name: string; category: string; price: number | null; cost: number | null;
    stock: number; minStock: number; barcode: string | null; description: string | null;
    supplier: string; expirationDate: Date | null;
    unit: UnitOfMeasure | null; taxRate: TaxRate | null; cabys: string | null; // null = no vino en el archivo
  };
  existingId?: string;
};

const key = (v: string) => v.trim().toLowerCase();
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
// por unidad: enteros; las demás unidades: hasta 3 decimales
const isQty = (v: number | undefined, unit: UnitOfMeasure) =>
  v === undefined || (Number.isFinite(v) && v >= 0 && (unit === "UNIT" ? Number.isInteger(v) : roundQty(v) === v));

export async function importProducts(rows: ImportRow[], dryRun: boolean, userId: string, opts: Partial<ImportOptions> = {}, locationId?: string) {
  const options = { ...STRICT_OPTIONS, ...opts };
  const defaultCategory = options.defaultCategory.trim();

  const [existing, categories, suppliers, company] = await Promise.all([
    prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, barcode: true, unit: true, stock: true } }),
    prisma.category.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
    prisma.supplier.findMany({ select: { id: true, name: true } }),
    getCompany(),
  ]);
  const existingBySku = new Map(existing.map((p) => [key(p.sku), p.id]));
  const existingById = new Map(existing.map((p) => [p.id, p]));
  const barcodeOwner = new Map(existing.filter((p) => p.barcode).map((p) => [key(p.barcode!), p.id]));
  const categoryByName = new Map(categories.map((c) => [key(c.name), c.id]));
  const supplierByName = new Map(suppliers.map((s) => [key(s.name), s.id]));

  const groups: Record<Issue, number> = {
    missingCategory: 0, missingSku: 0, missingPrice: 0, badNumbers: 0, invalidDate: 0,
    barcodeConflict: 0, repeatedSku: 0, existing: 0, badFiscal: 0,
  };
  const usedSkus = new Set(existingBySku.keys());
  let skuCounter = 0;
  const nextSku = () => {
    let s: string;
    do s = `IMP-${String(++skuCounter).padStart(4, "0")}`;
    while (usedSkus.has(key(s)));
    return s;
  };

  const seenInFile = new Set<string>();
  const seenBarcodes = new Set<string>();
  const prepared: Prepared[] = [];

  for (const row of rows) {
    const fixes: string[] = [];
    const errors: string[] = [];
    let pending = false;

    const name = text(row.name);
    if (!name) errors.push("Falta el nombre (no se puede saber qué producto es)");
    else if (name.length > 200) errors.push("El nombre es demasiado largo (máx. 200)");

    // SKU
    let sku = text(row.sku);
    if (!sku) {
      groups.missingSku++;
      if (options.generateSku) {
        sku = nextSku();
        fixes.push(`SKU generado: ${sku}`);
      } else errors.push("Falta el SKU");
    } else if (sku.length > 64) errors.push("El SKU es demasiado largo (máx. 64)");

    // un producto que ya existe: si se salta, nada más importa; si se actualiza, conserva lo que el archivo no trae
    const existingId = sku ? existingBySku.get(key(sku)) : undefined;
    if (existingId && !options.updateExisting && !seenInFile.has(key(sku))) {
      groups.existing++;
      prepared.push({
        row,
        result: { rowNumber: row.rowNumber, sku, name, status: "skip", pending: false, fixes: ["Ya existe un producto con este SKU: se salta"], errors: [] },
        data: { sku, name, category: "", price: null, cost: null, stock: 0, minStock: 0, barcode: null, description: null, supplier: "", expirationDate: null, unit: null, taxRate: null, cabys: null },
        existingId,
      });
      seenInFile.add(key(sku));
      continue;
    }
    const updating = Boolean(existingId && options.updateExisting);

    // categoría
    let category = text(row.category);
    if (!category && !updating) {
      groups.missingCategory++;
      if (defaultCategory) {
        category = defaultCategory;
        fixes.push(`Categoría por defecto: ${defaultCategory}`);
      } else errors.push("Falta la categoría");
    }

    // precio: nunca se inventa; sin precio válido la fila puede entrar "Por completar"
    let price: number | null = row.price ?? null;
    if (updating && row.price === undefined) price = null; // actualización sin precio: conserva el actual
    else if (price === null || !Number.isFinite(price) || price <= 0) {
      groups.missingPrice++;
      price = null;
      if (options.pendingPrice) {
        pending = true;
        fixes.push("Sin precio válido: quedará Por completar");
      } else errors.push(row.price === undefined ? "Falta el precio" : "El precio debe ser un número mayor que 0");
    }

    // unidad, IVA y CABYS (opcionales). Van antes de los números: la unidad decide si el stock admite decimales.
    const unit: UnitOfMeasure | null = text(row.unit) ? parseUnit(text(row.unit)) : null;
    let taxRate: TaxRate | null = text(row.taxRate) ? parseTaxRate(text(row.taxRate)) : null;
    let cabys: string | null = text(row.cabys).replace(/\s/g, "") || null;
    const badUnit = Boolean(text(row.unit)) && unit === null;
    const badTax = Boolean(text(row.taxRate)) && taxRate === null;
    const badCabys = cabys !== null && !/^\d{13}$/.test(cabys);
    if (badUnit || badTax || badCabys) {
      groups.badFiscal++;
      if (options.ignoreBadFiscal) {
        if (badUnit) fixes.push(`Unidad "${text(row.unit)}" no reconocida: se usa la actual o "unidad"`);
        if (badTax) { taxRate = null; fixes.push(`IVA "${text(row.taxRate)}" no reconocido: se usa el actual o 13 %`); }
        if (badCabys) { cabys = null; fixes.push("CABYS inválido (13 dígitos): se deja vacío"); }
      } else {
        if (badUnit) errors.push(`Unidad no reconocida: "${text(row.unit)}" (usa unidad, kg, g, L, mL, m, cm o m²)`);
        if (badTax) errors.push(`IVA no reconocido: "${text(row.taxRate)}" (usa 13, 4, 2, 1 o Exento)`);
        if (badCabys) errors.push("El código CABYS debe tener 13 dígitos");
      }
    }
    const current = existingId && updating ? existingById.get(existingId) : undefined;
    const qtyUnit: UnitOfMeasure = unit ?? current?.unit ?? "UNIT";
    // pasar a "por unidad" un producto con stock fraccionado dejaría un stock imposible
    if (current && unit === "UNIT" && !Number.isInteger(Number(current.stock))) {
      errors.push(`No se puede pasar a "unidad": el stock actual (${Number(current.stock)}) tiene decimales`);
    }

    // números opcionales
    let stock = row.stock ?? 0;
    let minStock = row.minStock ?? 0;
    let cost: number | null = row.cost ?? null;
    const badCost = cost !== null && (!Number.isFinite(cost) || cost < 0);
    const qtyRule = qtyUnit === "UNIT" ? "un número entero de 0 o más" : "un número de 0 o más (máx. 3 decimales)";
    if (!isQty(row.stock, qtyUnit) || !isQty(row.minStock, qtyUnit) || badCost) {
      groups.badNumbers++;
      if (options.fixNumbers) {
        const fixQty = (v: number) => (Number.isFinite(v) && v > 0 ? (qtyUnit === "UNIT" ? Math.round(v) : roundQty(v)) : 0);
        if (!isQty(row.stock, qtyUnit)) { stock = fixQty(stock); fixes.push(`Stock corregido a ${stock}`); }
        if (!isQty(row.minStock, qtyUnit)) { minStock = fixQty(minStock); fixes.push(`Stock mínimo corregido a ${minStock}`); }
        if (badCost) { cost = null; fixes.push("Costo inválido: se deja vacío"); }
      } else {
        if (!isQty(row.stock, qtyUnit)) errors.push(`El stock debe ser ${qtyRule}`);
        if (!isQty(row.minStock, qtyUnit)) errors.push(`El stock mínimo debe ser ${qtyRule}`);
        if (badCost) errors.push("El costo no puede ser negativo");
      }
    }

    // fecha
    let expirationDate: Date | null = null;
    if (row.expirationDate !== undefined) {
      const parsed = Date.parse(row.expirationDate);
      if (Number.isNaN(parsed)) {
        groups.invalidDate++;
        if (options.ignoreInvalidDate) fixes.push("Fecha de vencimiento inválida: se importa sin fecha");
        else errors.push("La fecha de vencimiento no es válida (usa AAAA-MM-DD)");
      } else expirationDate = new Date(parsed);
    }

    const result: RowResult = { rowNumber: row.rowNumber, sku, name, status: "create", pending, fixes, errors };

    // código de barras (para una actualización, su propio código no es conflicto)
    let barcode: string | null = text(row.barcode) || null;
    if (barcode) {
      const owner = barcodeOwner.get(key(barcode));
      if ((owner && owner !== existingId) || seenBarcodes.has(key(barcode))) {
        groups.barcodeConflict++;
        if (options.dropConflictingBarcode) {
          fixes.push("Código de barras ya usado por otro producto: se importa sin código");
          barcode = null;
        } else errors.push(owner ? "El código de barras ya lo tiene otro producto" : "Código de barras repetido en el archivo");
      }
    }

    if (errors.length) result.status = "error";
    else if (sku && seenInFile.has(key(sku))) {
      groups.repeatedSku++;
      if (options.skipRepeated) {
        result.status = "skip";
        fixes.push("SKU repetido en el archivo: se usa solo la primera fila");
      } else {
        result.status = "error";
        errors.push("SKU repetido en el archivo");
      }
    } else if (updating) {
      groups.existing++;
      result.status = "update";
      result.pending = false;
      // precio inválido en una actualización: no se toca el precio actual
      if (pending) {
        result.fixes = result.fixes.filter((f) => !f.startsWith("Sin precio"));
        result.fixes.push("Precio inválido: se conserva el precio actual");
      }
    }

    if (result.status === "create" || result.status === "update") {
      seenInFile.add(key(sku));
      usedSkus.add(key(sku));
      if (barcode) seenBarcodes.add(key(barcode));
    }
    prepared.push({
      row,
      result,
      data: {
        sku, name, category, price, cost, stock, minStock, barcode,
        description: text(row.description) || null, supplier: text(row.supplier), expirationDate,
        unit, taxRate, cabys,
      },
      ...(existingId && { existingId }),
    });
  }

  // límite del plan: solo cuentan los productos nuevos (los primeros del archivo tienen prioridad)
  const { maxProducts } = company.limits;
  if (maxProducts !== null) {
    let room = maxProducts - existing.length;
    for (const p of prepared) {
      if (p.result.status !== "create") continue;
      if (room > 0) room--;
      else {
        p.result.status = "error";
        p.result.errors.push(`Tu plan permite ${maxProducts} productos: esta fila no entra`);
      }
    }
  }

  const toSave = prepared.filter((p) => p.result.status === "create" || p.result.status === "update");
  const newCategories = new Map<string, string>();
  const newSuppliers = new Map<string, string>();
  for (const p of toSave) {
    if (p.data.category && !categoryByName.has(key(p.data.category))) newCategories.set(key(p.data.category), p.data.category);
    if (p.data.supplier && !supplierByName.has(key(p.data.supplier))) newSuppliers.set(key(p.data.supplier), p.data.supplier);
  }

  const results = prepared.map((p) => p.result);
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const summary = {
    total: rows.length,
    toCreate: count("create"),
    toUpdate: count("update"),
    skipped: count("skip"),
    errors: count("error"),
    pending: results.filter((r) => (r.status === "create") && r.pending).length,
    fixed: results.filter((r) => r.status !== "error" && r.fixes.length > 0).length,
    newCategories: [...newCategories.values()],
    newSuppliers: [...newSuppliers.values()],
    groups,
  };

  if (dryRun || toSave.length === 0) return { dryRun, created: 0, updated: 0, summary, rows: results };

  const companyId = currentCompanyId();
  const location = await resolveLocation(locationId);
  await prisma.$transaction(async (tx) => {
    for (const [k, name] of newCategories) {
      const c = await tx.category.create({ data: { companyId, name } });
      categoryByName.set(k, c.id);
    }
    for (const [k, name] of newSuppliers) {
      const s = await tx.supplier.create({ data: { companyId, name } });
      supplierByName.set(k, s.id);
    }

    const creates = toSave.filter((p) => p.result.status === "create");
    if (creates.length) {
      const created = await tx.product.createManyAndReturn({
        select: { id: true, stock: true },
        data: creates.map(({ data, result }) => ({
          companyId,
          sku: data.sku,
          name: data.name,
          description: data.description,
          barcode: data.barcode,
          price: data.price ?? 0,
          pendingReview: result.pending,
          cost: data.cost,
          stock: data.stock,
          minStock: data.minStock,
          categoryId: categoryByName.get(key(data.category))!,
          supplierId: data.supplier ? supplierByName.get(key(data.supplier))! : null,
          expirationDate: data.expirationDate,
          unit: data.unit ?? "UNIT",
          taxRate: data.taxRate ?? "RATE_13",
          cabys: data.cabys,
        })),
      });
      // nacen manejados en la ubicación elegida (con su stock, aunque sea 0) y el stock inicial queda
      // explicado por un movimiento, igual que al crear un producto a mano
      await tx.productStock.createMany({
        data: created.map((p) => ({ companyId, productId: p.id, locationId: location.id, quantity: p.stock })),
      });
      const initial = created.filter((p) => Number(p.stock) > 0);
      if (initial.length) {
        await tx.stockMovement.createMany({
          data: initial.map((p) => ({
            companyId, productId: p.id, userId, type: "IN" as const, quantity: p.stock,
            reason: "Stock inicial (importación)", source: "INITIAL" as const, locationId: location.id,
          })),
        });
      }
    }

    // actualizar existentes: solo los campos que trae el archivo; el STOCK nunca (se mueve con movimientos)
    for (const { row, data, existingId } of toSave.filter((p) => p.result.status === "update")) {
      const changes = {
        ...(text(row.name) && { name: data.name }),
        ...(data.category && { categoryId: categoryByName.get(key(data.category))! }),
        ...(data.price !== null && { price: data.price, pendingReview: false }),
        ...(data.cost !== null && { cost: data.cost }),
        ...(row.minStock !== undefined && { minStock: data.minStock }),
        ...(data.barcode && { barcode: data.barcode }),
        ...(data.description && { description: data.description }),
        ...(data.supplier && { supplierId: supplierByName.get(key(data.supplier))! }),
        ...(data.expirationDate && { expirationDate: data.expirationDate }),
        ...(data.unit && { unit: data.unit }),
        ...(data.taxRate && { taxRate: data.taxRate }),
        ...(data.cabys && { cabys: data.cabys }),
      };
      await tx.product.update({ where: { id: existingId! }, data: changes });
      // misma forma que una edición manual: el historial de precios lee `changes.price`
      await logAudit(userId, "UPDATE", "Product", existingId!, { ...changes, via: "import" }, tx);
    }

    await logAudit(userId, "CREATE", "ProductImport", companyId, {
      created: creates.length,
      updated: summary.toUpdate,
      pending: summary.pending,
      skipped: summary.skipped,
      errors: summary.errors,
      newCategories: summary.newCategories,
      newSuppliers: summary.newSuppliers,
    }, tx);
  }, { timeout: 60_000 });

  return { dryRun, created: summary.toCreate, updated: summary.toUpdate, summary, rows: results };
}

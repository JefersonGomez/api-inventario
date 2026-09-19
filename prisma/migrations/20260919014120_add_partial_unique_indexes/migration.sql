-- DropIndex
DROP INDEX "Category_name_key";

-- DropIndex
DROP INDEX "Product_barcode_key";

-- DropIndex
DROP INDEX "Product_sku_key";

-- Índices únicos parciales: la unicidad solo aplica a filas activas (no eliminadas)
CREATE UNIQUE INDEX "Category_name_active_key" ON "Category"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Product_sku_active_key" ON "Product"("sku") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Product_barcode_active_key" ON "Product"("barcode") WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;
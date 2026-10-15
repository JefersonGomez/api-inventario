-- CreateEnum
CREATE TYPE "MovementSource" AS ENUM ('MANUAL', 'INITIAL', 'PURCHASE_RECEIPT', 'SALE', 'RETURN', 'COUNT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIT', 'KG', 'G', 'L', 'ML', 'M', 'CM', 'M2');

-- CreateEnum
CREATE TYPE "TaxRate" AS ENUM ('EXEMPT', 'RATE_1', 'RATE_2', 'RATE_4', 'RATE_13');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "cabys" TEXT,
ADD COLUMN     "taxRate" "TaxRate" NOT NULL DEFAULT 'RATE_13',
ADD COLUMN     "unit" "UnitOfMeasure" NOT NULL DEFAULT 'UNIT',
ALTER COLUMN "stock" SET DEFAULT 0,
ALTER COLUMN "stock" SET DATA TYPE DECIMAL(14,3),
ALTER COLUMN "minStock" SET DEFAULT 0,
ALTER COLUMN "minStock" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "PurchaseRequest" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "source" "MovementSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceId" TEXT,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(14,3);

-- CreateIndex
CREATE INDEX "StockMovement_companyId_source_sourceId_idx" ON "StockMovement"("companyId", "source", "sourceId");

-- Datos: las recepciones de órdenes de compra ya registradas pasan a tener su origen.
-- Hasta ahora la única pista era el texto del motivo ("Recepción de orden de compra <id>").
UPDATE "StockMovement"
SET "source" = 'PURCHASE_RECEIPT',
    "sourceId" = substring("reason" from 'Recepción de orden de compra ([0-9a-f-]{36})')
WHERE "reason" ~ '^Recepción de orden de compra [0-9a-f-]{36}$';

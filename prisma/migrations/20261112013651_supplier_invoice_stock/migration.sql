-- AlterEnum
ALTER TYPE "MovementSource" ADD VALUE 'SUPPLIER_INVOICE';

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "stockReceivedAt" TIMESTAMP(3),
ADD COLUMN     "stockReceivedById" TEXT;

-- CreateTable
CREATE TABLE "SupplierProductMap" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProductMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProductMap_companyId_supplierId_key_key" ON "SupplierProductMap"("companyId", "supplierId", "key");

-- AddForeignKey
ALTER TABLE "SupplierProductMap" ADD CONSTRAINT "SupplierProductMap_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProductMap" ADD CONSTRAINT "SupplierProductMap_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProductMap" ADD CONSTRAINT "SupplierProductMap_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


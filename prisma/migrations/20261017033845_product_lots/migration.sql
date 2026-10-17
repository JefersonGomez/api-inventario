-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "tracksLots" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "lots" JSONB;

-- AlterTable
ALTER TABLE "StockTransferItem" ADD COLUMN     "lots" JSONB;

-- CreateTable
CREATE TABLE "ProductLot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductLot_companyId_expiresAt_idx" ON "ProductLot"("companyId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLot_productId_locationId_code_key" ON "ProductLot"("productId", "locationId", "code");

-- AddForeignKey
ALTER TABLE "ProductLot" ADD CONSTRAINT "ProductLot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLot" ADD CONSTRAINT "ProductLot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLot" ADD CONSTRAINT "ProductLot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

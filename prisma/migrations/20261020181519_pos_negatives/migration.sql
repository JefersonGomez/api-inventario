-- CreateEnum
CREATE TYPE "NegativeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "CashRegister" ADD COLUMN     "customerDisplay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "posShowStock" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "StockNegative" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "stockBefore" DECIMAL(14,3) NOT NULL,
    "reportedById" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "status" "NegativeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "countedQuantity" DECIMAL(14,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockNegative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockNegative_companyId_status_idx" ON "StockNegative"("companyId", "status");

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

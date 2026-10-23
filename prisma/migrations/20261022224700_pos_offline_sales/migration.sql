-- DropForeignKey
ALTER TABLE "StockNegative" DROP CONSTRAINT "StockNegative_authorizedById_fkey";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "clientSaleId" TEXT;

-- AlterTable
ALTER TABLE "StockNegative" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "authorizedById" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Document_companyId_clientSaleId_key" ON "Document"("companyId", "clientSaleId");

-- AddForeignKey
ALTER TABLE "StockNegative" ADD CONSTRAINT "StockNegative_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


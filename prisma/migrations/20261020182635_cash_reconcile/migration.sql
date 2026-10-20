-- AlterTable
ALTER TABLE "CashSession" ADD COLUMN     "cardDeclared" DECIMAL(18,2),
ADD COLUMN     "reconcileNote" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "reconciledById" TEXT;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

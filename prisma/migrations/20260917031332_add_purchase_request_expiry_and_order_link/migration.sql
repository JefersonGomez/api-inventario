-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "purchaseOrderId" TEXT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

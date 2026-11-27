-- AlterTable
ALTER TABLE "SubscriptionPayment" ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "invoiceAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invoiceError" TEXT,
ADD COLUMN     "invoicingAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_documentId_key" ON "SubscriptionPayment"("documentId");


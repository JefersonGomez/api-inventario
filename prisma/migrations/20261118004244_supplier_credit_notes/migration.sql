-- CreateEnum
CREATE TYPE "SupplierDocType" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "referenceInvoiceId" TEXT,
ADD COLUMN     "type" "SupplierDocType" NOT NULL DEFAULT 'INVOICE';

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "creditNoteId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_creditNoteId_key" ON "SupplierPayment"("creditNoteId");

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_referenceInvoiceId_fkey" FOREIGN KEY ("referenceInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SupplierInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;


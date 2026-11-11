-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "clave" TEXT,
ADD COLUMN     "haciendaStatus" TEXT,
ADD COLUMN     "xml" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_companyId_clave_key" ON "SupplierInvoice"("companyId", "clave");


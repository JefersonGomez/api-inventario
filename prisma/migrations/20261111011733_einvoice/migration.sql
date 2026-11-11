-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "EInvoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "xml" TEXT NOT NULL,
    "responseXml" TEXT,
    "message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_documentId_key" ON "EInvoice"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_clave_key" ON "EInvoice"("clave");

-- CreateIndex
CREATE INDEX "EInvoice_companyId_status_idx" ON "EInvoice"("companyId", "status");

-- AddForeignKey
ALTER TABLE "EInvoice" ADD CONSTRAINT "EInvoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EInvoice" ADD CONSTRAINT "EInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

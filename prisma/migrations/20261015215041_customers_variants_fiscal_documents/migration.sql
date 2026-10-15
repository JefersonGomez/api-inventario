-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('FISICA', 'JURIDICA', 'DIMEX', 'NITE', 'EXTRANJERO');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'TICKET');

-- CreateEnum
CREATE TYPE "SaleCondition" AS ENUM ('CASH', 'CREDIT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'SINPE', 'TRANSFER', 'OTHER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "addressDetail" TEXT,
ADD COLUMN     "canton" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "economicActivity" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" "IdType",
ADD COLUMN     "invoiceEmail" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "province" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" "IdType";

-- CreateTable
CREATE TABLE "ProductGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attributeNames" TEXT[],
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "idType" "IdType",
    "idNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "economicActivity" TEXT,
    "creditLimit" DECIMAL(14,2),
    "creditDays" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "branchCode" TEXT NOT NULL DEFAULT '001',
    "terminalCode" TEXT NOT NULL DEFAULT '00001',
    "number" INTEGER NOT NULL,
    "consecutive" TEXT NOT NULL,
    "customerId" TEXT,
    "saleCondition" "SaleCondition" NOT NULL DEFAULT 'CASH',
    "creditDays" INTEGER,
    "currency" "CurrencyCode" NOT NULL,
    "subtotal" DECIMAL(18,5) NOT NULL,
    "discountTotal" DECIMAL(18,5) NOT NULL,
    "taxTotal" DECIMAL(18,5) NOT NULL,
    "total" DECIMAL(18,5) NOT NULL,
    "referenceDocumentId" TEXT,
    "referenceReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "cabys" TEXT,
    "unit" "UnitOfMeasure" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(18,5) NOT NULL,
    "discount" DECIMAL(18,5) NOT NULL,
    "taxRate" "TaxRate" NOT NULL,
    "taxAmount" DECIMAL(18,5) NOT NULL,
    "subtotal" DECIMAL(18,5) NOT NULL,
    "total" DECIMAL(18,5) NOT NULL,

    CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPayment" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(18,5) NOT NULL,

    CONSTRAINT "DocumentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "companyId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "branchCode" TEXT NOT NULL,
    "terminalCode" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("companyId","type","branchCode","terminalCode")
);

-- CreateIndex
CREATE INDEX "ProductGroup_companyId_idx" ON "ProductGroup"("companyId");

-- CreateIndex
CREATE INDEX "Customer_companyId_idx" ON "Customer"("companyId");

-- CreateIndex
CREATE INDEX "Document_companyId_issuedAt_idx" ON "Document"("companyId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Document_companyId_type_branchCode_terminalCode_number_key" ON "Document"("companyId", "type", "branchCode", "terminalCode", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLine_documentId_lineNumber_key" ON "DocumentLine"("documentId", "lineNumber");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ProductGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroup" ADD CONSTRAINT "ProductGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_referenceDocumentId_fkey" FOREIGN KEY ("referenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPayment" ADD CONSTRAINT "DocumentPayment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Identificación única por empresa entre los clientes activos (los borrados no cuentan)
CREATE UNIQUE INDEX "Customer_companyId_idType_idNumber_active_key"
  ON "Customer"("companyId", "idType", "idNumber")
  WHERE "deletedAt" IS NULL AND "idNumber" IS NOT NULL;

-- Nombre de producto base único por empresa entre los activos
CREATE UNIQUE INDEX "ProductGroup_companyId_name_active_key"
  ON "ProductGroup"("companyId", "name")
  WHERE "deletedAt" IS NULL;

-- Comprobantes inmutables: una vez emitidos no se editan ni se borran (se corrigen con notas).
-- TRUNCATE no dispara estos triggers, así que la limpieza de la base de tests sigue funcionando.
CREATE FUNCTION forbid_document_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Los comprobantes emitidos no se pueden modificar ni borrar (usa una nota de crédito o débito)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Document_immutable" BEFORE UPDATE OR DELETE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION forbid_document_change();
CREATE TRIGGER "DocumentLine_immutable" BEFORE UPDATE OR DELETE ON "DocumentLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_document_change();
CREATE TRIGGER "DocumentPayment_immutable" BEFORE UPDATE OR DELETE ON "DocumentPayment"
  FOR EACH ROW EXECUTE FUNCTION forbid_document_change();

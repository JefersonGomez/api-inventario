-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "creditable" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SupplierInvoiceTax" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rate" "TaxRate" NOT NULL,
    "base" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SupplierInvoiceTax_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceTax_invoiceId_rate_key" ON "SupplierInvoiceTax"("invoiceId", "rate");

-- AddForeignKey
ALTER TABLE "SupplierInvoiceTax" ADD CONSTRAINT "SupplierInvoiceTax_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las facturas que ya existían quedan en una sola tarifa, la más cercana a su IVA / subtotal
INSERT INTO "SupplierInvoiceTax" ("id", "invoiceId", "rate", "base", "tax")
SELECT gen_random_uuid()::text, i."id",
  (CASE
    WHEN i."tax" = 0 OR i."subtotal" = 0 THEN 'EXEMPT'
    WHEN i."tax" / i."subtotal" >= 0.085 THEN 'RATE_13'
    WHEN i."tax" / i."subtotal" >= 0.03 THEN 'RATE_4'
    WHEN i."tax" / i."subtotal" >= 0.015 THEN 'RATE_2'
    ELSE 'RATE_1'
  END)::"TaxRate",
  i."subtotal", i."tax"
FROM "SupplierInvoice" i;

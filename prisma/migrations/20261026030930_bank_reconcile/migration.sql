-- CreateEnum
CREATE TYPE "BankMatchType" AS ENUM ('SALE_PAYMENT', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'CASH_DEPOSIT', 'CARD_BATCH');

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "fee" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "BankMatch" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "sourceType" "BankMatchType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "BankMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankMatch_bankTransactionId_idx" ON "BankMatch"("bankTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankMatch_sourceType_sourceId_key" ON "BankMatch"("sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

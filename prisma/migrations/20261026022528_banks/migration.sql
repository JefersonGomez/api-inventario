-- CreateEnum
CREATE TYPE "BankCategory" AS ENUM ('BANK_FEE', 'INTEREST', 'OWNER_WITHDRAWAL', 'OWNER_CONTRIBUTION', 'EXPENSE', 'OTHER_INCOME', 'OTHER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "CustomerPayment" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "bankAccountId" TEXT;

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "number" TEXT,
    "currency" "CurrencyCode" NOT NULL DEFAULT 'CRC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "inserted" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "dateFrom" DATE,
    "dateTo" DATE,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "importId" TEXT,
    "date" DATE NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "category" "BankCategory",
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashDeposit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "locationId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "depositedAt" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_companyId_idx" ON "BankAccount"("companyId");

-- CreateIndex
CREATE INDEX "BankImport_companyId_bankAccountId_idx" ON "BankImport"("companyId", "bankAccountId");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_bankAccountId_date_idx" ON "BankTransaction"("companyId", "bankAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_date_reference_amount_descrip_key" ON "BankTransaction"("bankAccountId", "date", "reference", "amount", "description");

-- CreateIndex
CREATE INDEX "CashDeposit_companyId_bankAccountId_depositedAt_idx" ON "CashDeposit"("companyId", "bankAccountId", "depositedAt");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImport" ADD CONSTRAINT "BankImport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImport" ADD CONSTRAINT "BankImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImport" ADD CONSTRAINT "BankImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

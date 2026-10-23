-- AlterTable
ALTER TABLE "CashSession" ADD COLUMN     "sinpeDeclared" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "requirePaymentRef" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sinpeName" TEXT,
ADD COLUMN     "sinpeNumber" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "sinpeName" TEXT,
ADD COLUMN     "sinpeNumber" TEXT;


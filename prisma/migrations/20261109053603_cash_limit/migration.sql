-- AlterTable
ALTER TABLE "CashSession" ADD COLUMN     "overLimitAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "cashLimit" INTEGER DEFAULT 800000;

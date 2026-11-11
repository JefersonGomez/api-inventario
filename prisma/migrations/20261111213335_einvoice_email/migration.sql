-- AlterTable
ALTER TABLE "EInvoice" ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "emailedTo" TEXT;

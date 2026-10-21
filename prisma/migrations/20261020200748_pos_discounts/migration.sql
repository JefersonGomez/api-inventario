-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "DiscountScope" AS ENUM ('LINE', 'TOTAL', 'BOTH');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "discountAuthorizedById" TEXT;

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "discountLabel" TEXT;

-- CreateTable
CREATE TABLE "DiscountType" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DiscountKind" NOT NULL,
    "value" DECIMAL(14,2),
    "maxPercent" DECIMAL(5,2),
    "appliesTo" "DiscountScope" NOT NULL DEFAULT 'BOTH',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscountType_companyId_idx" ON "DiscountType"("companyId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_discountAuthorizedById_fkey" FOREIGN KEY ("discountAuthorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountType" ADD CONSTRAINT "DiscountType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

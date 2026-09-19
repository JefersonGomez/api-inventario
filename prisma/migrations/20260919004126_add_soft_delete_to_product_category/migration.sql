-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "deleteAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deleteAt" TEXT;

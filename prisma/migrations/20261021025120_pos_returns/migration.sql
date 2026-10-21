-- CreateEnum
CREATE TYPE "ReturnCondition" AS ENUM ('GOOD', 'DAMAGED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "returnDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "returnAuthorizedById" TEXT;

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "returnCondition" "ReturnCondition",
ADD COLUMN     "sourceLineId" TEXT;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_returnAuthorizedById_fkey" FOREIGN KEY ("returnAuthorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_sourceLineId_fkey" FOREIGN KEY ("sourceLineId") REFERENCES "DocumentLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

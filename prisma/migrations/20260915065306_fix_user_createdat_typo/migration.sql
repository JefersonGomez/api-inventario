/*
  Warnings:

  - The values [APROVED] on the enum `PurchaseRequestStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `createAt` on the `User` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PurchaseRequestStatus_new" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "public"."PurchaseRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PurchaseRequest" ALTER COLUMN "status" TYPE "PurchaseRequestStatus_new" USING ("status"::text::"PurchaseRequestStatus_new");
ALTER TYPE "PurchaseRequestStatus" RENAME TO "PurchaseRequestStatus_old";
ALTER TYPE "PurchaseRequestStatus_new" RENAME TO "PurchaseRequestStatus";
DROP TYPE "public"."PurchaseRequestStatus_old";
ALTER TABLE "PurchaseRequest" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "createAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

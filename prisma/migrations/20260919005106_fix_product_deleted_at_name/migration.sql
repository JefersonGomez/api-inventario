/*
  Warnings:

  - You are about to drop the column `deleteAt` on the `Product` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "deleteAt",
ADD COLUMN     "deletedAt" TEXT;

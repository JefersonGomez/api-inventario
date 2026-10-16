-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "pinSetAt" TIMESTAMP(3),
ADD COLUMN     "pinSetBySelf" BOOLEAN NOT NULL DEFAULT false;

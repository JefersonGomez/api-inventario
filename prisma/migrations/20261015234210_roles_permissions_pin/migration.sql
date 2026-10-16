-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'MANAGER';
ALTER TYPE "Role" ADD VALUE 'CASHIER';
ALTER TYPE "Role" ADD VALUE 'ACCOUNTANT';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "revokedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

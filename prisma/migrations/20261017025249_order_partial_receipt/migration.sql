-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "cancelReason" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "receivedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- Datos: las órdenes ya recibidas (antes solo había recepción completa) quedan con todo recibido
UPDATE "PurchaseOrderItem" i SET "receivedQuantity" = i."quantity"
FROM "PurchaseOrder" o WHERE o."id" = i."purchaseOrderId" AND o."status" = 'RECEIVED';

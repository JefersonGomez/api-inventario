-- AlterEnum
ALTER TYPE "EInvoiceStatus" ADD VALUE 'ERROR';

-- AlterTable
ALTER TABLE "EInvoice" ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ALTER COLUMN "clave" DROP NOT NULL,
ALTER COLUMN "xml" DROP NOT NULL;

-- CreateTable
CREATE TABLE "EInvoiceSettings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "environment" TEXT NOT NULL DEFAULT 'pruebas',
    "username" TEXT,
    "passwordEnc" TEXT,
    "p12Enc" TEXT,
    "pinEnc" TEXT,
    "holderId" TEXT,
    "holderName" TEXT,
    "keyExpiresAt" TIMESTAMP(3),
    "provider" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceSettings_companyId_key" ON "EInvoiceSettings"("companyId");

-- AddForeignKey
ALTER TABLE "EInvoiceSettings" ADD CONSTRAINT "EInvoiceSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

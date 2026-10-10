-- Multi-empresa: Company pasa a ser el tenant (uuid), se agrega Membership (rol por empresa)
-- y companyId en las tablas de negocio. Los datos existentes quedan en una sola empresa.

CREATE TYPE "PlanCode" AS ENUM ('BASIC', 'PRO', 'BUSINESS');

ALTER TABLE "User"
  ADD COLUMN "lastCompanyId" TEXT,
  ADD COLUMN "plan" "PlanCode" NOT NULL DEFAULT 'BASIC';

-- Company: id Int (fila única = 1) → uuid; conserva el nombre que ya tenía
ALTER TABLE "Company" DROP CONSTRAINT "Company_pkey";
ALTER TABLE "Company" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "Company" ALTER COLUMN "id" SET DATA TYPE TEXT USING gen_random_uuid()::text;
ALTER TABLE "Company" ADD CONSTRAINT "Company_pkey" PRIMARY KEY ("id");
ALTER TABLE "Company"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ownerId" TEXT;

-- si hay usuarios pero nunca se configuró la empresa, se crea una
INSERT INTO "Company" ("id", "name", "updatedAt")
SELECT gen_random_uuid()::text, 'Empresa demo', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Company") AND EXISTS (SELECT 1 FROM "User");

-- dueño = el admin más antiguo (o el usuario más antiguo si no hay admin)
UPDATE "Company" SET "ownerId" = (
  SELECT "id" FROM "User" ORDER BY ("role" = 'ADMIN') DESC, "createdAt" ASC LIMIT 1
);
DELETE FROM "Company" WHERE "ownerId" IS NULL;
ALTER TABLE "Company" ALTER COLUMN "ownerId" SET NOT NULL;

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- cada usuario entra a la empresa con su rol actual; "desactivado" pasa a ser por empresa
INSERT INTO "Membership" ("id", "userId", "companyId", "role", "isActive", "createdAt")
SELECT gen_random_uuid()::text, u."id", c."id", u."role", u."isActive", u."createdAt"
FROM "User" u CROSS JOIN "Company" c;
UPDATE "User" SET "isActive" = true, "lastCompanyId" = (SELECT "id" FROM "Company" LIMIT 1);

ALTER TABLE "User" DROP COLUMN "role";

-- la sesión recuerda su empresa: refrescar el token no la cambia
ALTER TABLE "RefreshToken" ADD COLUMN "companyId" TEXT;

-- companyId en las tablas de negocio: se agrega nulo, se rellena y se vuelve obligatorio
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Category','Supplier','Product','StockMovement','PurchaseRequest','PurchaseOrder','AuditLog','Notification'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN "companyId" TEXT', t);
    EXECUTE format('UPDATE %I SET "companyId" = (SELECT "id" FROM "Company" LIMIT 1)', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "companyId" SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE', t, t || '_companyId_fkey');
  END LOOP;
END $$;

-- unicidad por empresa (antes era global)
DROP INDEX "Supplier_name_key";
CREATE UNIQUE INDEX "Supplier_companyId_name_key" ON "Supplier"("companyId", "name");
DROP INDEX "Category_name_active_key";
DROP INDEX "Product_sku_active_key";
DROP INDEX "Product_barcode_active_key";
CREATE UNIQUE INDEX "Category_companyId_name_active_key" ON "Category"("companyId", "name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Product_companyId_sku_active_key" ON "Product"("companyId", "sku") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Product_companyId_barcode_active_key" ON "Product"("companyId", "barcode") WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;

-- índices
DROP INDEX "Notification_userId_createdAt_idx";
CREATE INDEX "Notification_userId_companyId_createdAt_idx" ON "Notification"("userId", "companyId", "createdAt");
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");
CREATE INDEX "Category_companyId_idx" ON "Category"("companyId");
CREATE INDEX "Product_companyId_idx" ON "Product"("companyId");
CREATE INDEX "PurchaseOrder_companyId_idx" ON "PurchaseOrder"("companyId");
CREATE INDEX "PurchaseRequest_companyId_idx" ON "PurchaseRequest"("companyId");
CREATE INDEX "StockMovement_companyId_idx" ON "StockMovement"("companyId");
CREATE INDEX "Company_ownerId_idx" ON "Company"("ownerId");
CREATE INDEX "Membership_companyId_idx" ON "Membership"("companyId");
CREATE UNIQUE INDEX "Membership_userId_companyId_key" ON "Membership"("userId", "companyId");

ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

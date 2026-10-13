-- Moneda por empresa. Las existentes quedan en colones (mercado inicial: Costa Rica).
CREATE TYPE "CurrencyCode" AS ENUM ('CRC', 'USD');
ALTER TABLE "Company" ADD COLUMN "currency" "CurrencyCode" NOT NULL DEFAULT 'CRC';

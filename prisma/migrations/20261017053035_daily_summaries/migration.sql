-- CreateTable
CREATE TABLE "DailySummary" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailySummary_companyId_date_idx" ON "DailySummary"("companyId", "date");

-- AddForeignKey
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Datos: los resúmenes que se guardaban en PlatformSetting ("dailySummary:<empresa>:<fecha>") pasan a la tabla
INSERT INTO "DailySummary" ("id", "companyId", "date", "text", "data", "createdAt")
SELECT gen_random_uuid()::text, split_part(s."key", ':', 2), split_part(s."key", ':', 3), s."value"->>'text', s."value"->'data',
       COALESCE((s."value"->>'generatedAt')::timestamp, CURRENT_TIMESTAMP)
FROM "PlatformSetting" s
WHERE s."key" LIKE 'dailySummary:%' AND s."value"->>'text' IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Company" c WHERE c."id" = split_part(s."key", ':', 2));
DELETE FROM "PlatformSetting" WHERE "key" LIKE 'dailySummary:%';

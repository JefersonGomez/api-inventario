-- Panel de superadmin: marca de dueño de la plataforma y suspensión de empresas.
ALTER TABLE "User" ADD COLUMN "isPlatformOwner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "suspendedAt" TIMESTAMP(3), ADD COLUMN "suspensionReason" TEXT;

-- Constancia de aceptación de términos y política de privacidad (Ley 8968).
-- Las cuentas anteriores quedan en null: se crearon antes de que existieran los documentos.
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3), ADD COLUMN "termsVersion" TEXT;

-- Productos importados con datos faltantes (p. ej. sin precio) quedan "Por completar" hasta que se editen.
ALTER TABLE "Product" ADD COLUMN "pendingReview" BOOLEAN NOT NULL DEFAULT false;

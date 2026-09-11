/*
  Warnings:

  - Added the required column `avatarUrl` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- Step 1: Agregar columna como nullable temporalmente
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

-- Step 2: Asignar valor por defecto a las filas existentes
UPDATE "User" SET "avatarUrl" = 'avatars/default.png' WHERE "avatarUrl" IS NULL;

-- Step 3: Hacer la columna obligatoria (NOT NULL)
ALTER TABLE "User" ALTER COLUMN "avatarUrl" SET NOT NULL;

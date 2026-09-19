import { prisma } from "../../config/database.ts";

export async function createCategory(name: string, description: string | undefined) {
  if (!name) {
    throw new Error("El nombre de la categoría es obligatorio");
  }

  const exitsCategory = await prisma.category.findFirst({
    where: { name: name, deletedAt: null },
  });

  if (exitsCategory) {
    throw new Error("La categoría ya existe en el sistema");
  }

  return await prisma.category.create({
    data: {
      name: name,
      description: description ?? null,
    },
  });
}

export async function getAllCategories() {
  return await prisma.category.findMany({
    where: { deletedAt: null }, // ← nuevo
  });
}

export async function GetCategoryById(idCategory: string) {
  // cambia findUnique por findFirst: findUnique no admite combinar
  // el campo único (id) con un filtro extra (deletedAt) en este caso
  const existCategory = await prisma.category.findFirst({
    where: { id: idCategory, deletedAt: null }, // ← nuevo
  });

  if (!existCategory) {
    throw new Error("No se encontró la categoría que buscas");
  }

  return existCategory;
}

export async function updateCategory(idCategory: string, name: string, description: string | undefined) {
  if (!name) {
    throw new Error("El nombre de la categoría es obligatorio para actualizar");
  }

  return await prisma.category.update({
    where: { id: idCategory },
    data: {
      name: name,
      description: description ?? null,
    },
  });
}

export async function deleteCategory(idCategory: string) {
  // antes: prisma.category.delete(...)
  return await prisma.category.update({
    where: { id: idCategory },
    data: { deletedAt: new Date() },
  });
}
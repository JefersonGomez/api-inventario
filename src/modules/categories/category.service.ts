import { prisma } from "../../config/database.ts";

export async function createCategory(name: string, description: string | undefined) {
  if (!name) {
    throw new Error("El nombre de la categoría es obligatorio");
  }

  const exitsCategory = await prisma.category.findUnique({
    where: { name: name },
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
  return await prisma.category.findMany();
}

export async function GetCategoryById(idCategory: string) {
  const existCategory = await prisma.category.findUnique({
    where: { id: idCategory },
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
  return await prisma.category.delete({
    where: { id: idCategory },
  });
}
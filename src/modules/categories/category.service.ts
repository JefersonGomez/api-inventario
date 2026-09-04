import { prisma } from "../../config/database.ts";

export async function createCategory(name: string) {
  const exitsCategory = await prisma.category.findUnique({
    where: { name: name },
  });

  if (exitsCategory) {
    throw new Error("La categoria ya existe en sistema");
  }

  const newCategory = await prisma.category.create({
    data: {
      name: name,
    },
  });

  return newCategory;
}

export async function getAllCategories() {
    const allCategories = await prisma.category.findMany()
    return allCategories
}

export async function GetCategoryById(idCategory:string) {
    const existCategory = await prisma.category.findUnique({
        where:{id:idCategory}
    })

    if(existCategory==null){
        throw new Error("No se encontro la categoria que buscas")
    }

    return existCategory

    
}

export async function updateCategory(idCategory:string,name:string) {
    const updateCategories = await prisma.category.update({
        where:{id:idCategory},
        data:{
            name:name,
        }
    })
    

    return updateCategories
    
}

export async function deleteCategory(idCategory:string) {
    const categoryDelete = await prisma.category.delete({
        where:{id:idCategory}
    })

    return categoryDelete
    
}
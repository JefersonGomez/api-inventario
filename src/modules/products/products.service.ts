import { prisma } from "../../config/database.ts";

export async function createProduct(
  sku: string,
  name: string,
  description: string | undefined,
  price: number,
  stock: number,
  minStock: number,
  categoryId: string,
) {

    const existProduct = await prisma.product.findUnique({
        where:{sku:sku}
    })

    if(existProduct){
        throw new Error("El producto ya existe en sistema")
    }

    const existCategori = await prisma.category.findUnique({
        where:{id:categoryId}
    })
    if(existCategori ==null){
        throw new Error("La categoria invalida")
    }

    const newProduct = await prisma.product.create({
        data:{
            sku:sku,
            name:name,
            description:description ?? null,
            price:price,
            stock:stock,
            minStock:minStock,
            categoryId:categoryId,
        }
    })

    return newProduct

}


export async function getAllProducts() {
    const allProducts = await prisma.product.findMany({
        include:{category:true}
    })
    return allProducts
    
}

export async function getProductById(idProduct:string) {
    const existProduct = await prisma.product.findUnique({
        where:{id:idProduct},
        include:{category:true}
    })

    if(existProduct ==null){
        throw new Error("No se encontro el producto")

    }
    return existProduct
    
}

export async function updateProduct(id: string,
  name: string,
  description: string | undefined,
  price: number,
  minStock: number,
  categoryId: string) {


    const existCategori = await prisma.category.findUnique({
        where:{id:categoryId}
    })

    if(existCategori==null){
        throw new Error("Categoria ingresada invalida")
    }

    const updateProduct = await prisma.product.update({
        where:{id:id},
        data:{
            name:name,
            description:description ?? null,
            price:price,
            minStock:minStock,
            categoryId:categoryId
        }
    })

    return updateProduct
    
}

export async function deleteProduct(id:string) {
    const deleteProduct = await prisma.product.delete({
        where:{id:id}
    })

    return deleteProduct
    
}
import {z} from "zod"
export const productsSchemaCreate = z.object({
    sku:z.string().min(1,"El sku del producto es requerido"),
    name:z.string().min(1,"El nombre del producto es requerido"),
    description:z.string().optional(),
    price:z.number().positive(),
    stock:z.number().nonnegative(),
    minStock:z.number().nonnegative(),
    categoryId:z.uuid(),
})

export const productsSchemaUpdate = z.object({
    name: z.string().min(1, "El nombre del producto es requerido"),
    description: z.string().optional(),
    price: z.number().positive(),
    minStock: z.number().nonnegative(),
    categoryId: z.uuid(),
})
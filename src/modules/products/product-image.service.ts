// Foto del producto (Fase 5, pedido del usuario del 3-nov-2026): se sube como los avatares a /uploads/products,
// se ve en Productos y en el POS. Al cambiarla o quitarla se borra el archivo anterior.
import { prisma } from "../../config/database.ts"
import { removeUpload } from "../../shared/utils/upload.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getProductById } from "./products.service.ts"

const FOLDER = "products"
const notFound = () => Object.assign(new Error("No se encontró el producto"), { status: 404 })

export async function setProductImage(id: string, filename: string, userId: string) {
  const imageUrl = `/uploads/${FOLDER}/${filename}`
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null }, select: { imageUrl: true } })
  if (!product) {
    await removeUpload(imageUrl, FOLDER) // lo subido no queda huérfano
    throw notFound()
  }
  await prisma.product.update({ where: { id }, data: { imageUrl } })
  await logAudit(userId, "UPDATE", "Product", id, { imageUrl: { from: product.imageUrl, to: imageUrl } })
  await removeUpload(product.imageUrl, FOLDER)
  return getProductById(id)
}

export async function removeProductImage(id: string, userId: string) {
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null }, select: { imageUrl: true } })
  if (!product) throw notFound()
  if (product.imageUrl) {
    await prisma.product.update({ where: { id }, data: { imageUrl: null } })
    await logAudit(userId, "UPDATE", "Product", id, { imageUrl: { from: product.imageUrl, to: null } })
    await removeUpload(product.imageUrl, FOLDER)
  }
  return getProductById(id)
}

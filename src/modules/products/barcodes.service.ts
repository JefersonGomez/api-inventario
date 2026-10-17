// Generar códigos de barras para los productos que no tienen (Bloque 5D): EAN-13 interno (prefijo 20)
// con la siguiente secuencia libre de la empresa. Se cuentan también los eliminados: un código ya
// impreso en una etiqueta vieja nunca se reutiliza para otro producto.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { INTERNAL_PREFIX, internalEan } from "../../shared/ean.ts"
import { logAudit } from "../audit/audit.service.ts"

export const generateBarcodesSchema = z.object({
  productIds: z.array(z.uuid()).max(2000).optional(), // sin indicar: todos los que no tienen código
})

export async function generateBarcodes(input: z.infer<typeof generateBarcodesSchema>, userId: string) {
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      OR: [{ barcode: null }, { barcode: "" }],
      ...(input.productIds && { id: { in: input.productIds } }),
    },
    select: { id: true },
    orderBy: { name: "asc" },
  })
  if (products.length === 0) return { generated: 0, products: [] }

  return prisma.$transaction(async (tx) => {
    // última secuencia interna usada (códigos de 13 dígitos que empiezan con 20)
    const used = await tx.product.findMany({
      where: { barcode: { startsWith: INTERNAL_PREFIX } },
      select: { barcode: true },
    })
    let seq = Math.max(0, ...used.filter((p) => /^\d{13}$/.test(p.barcode!)).map((p) => Number(p.barcode!.slice(2, 12))))
    const assigned: { id: string; barcode: string }[] = []
    for (const p of products) {
      const barcode = internalEan(++seq)
      await tx.product.update({ where: { id: p.id }, data: { barcode } })
      assigned.push({ id: p.id, barcode })
    }
    await logAudit(userId, "UPDATE", "Product", assigned.length === 1 ? assigned[0]!.id : "varios", { barcodesGenerated: assigned }, tx)
    return { generated: assigned.length, products: assigned }
  })
}

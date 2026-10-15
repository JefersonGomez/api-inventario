import { prisma, type Db } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { logAudit } from "../audit/audit.service.ts"
import type { ProductGroupInput } from "./product-group.schema.ts"

const withCount = { _count: { select: { products: { where: { deletedAt: null } } } } } as const

async function assertUniqueName(name: string, exceptId?: string) {
  const other = await prisma.productGroup.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, deletedAt: null, ...(exceptId && { id: { not: exceptId } }) },
  })
  if (other) throw new Error("Ya existe un producto base con ese nombre")
}

export async function createProductGroup(input: ProductGroupInput, userId: string) {
  await assertUniqueName(input.name)
  const group = await prisma.productGroup.create({
    data: { companyId: currentCompanyId(), name: input.name, attributeNames: input.attributeNames },
    include: withCount,
  })
  await logAudit(userId, "CREATE", "ProductGroup", group.id, { ...input })
  return group
}

export function getProductGroups() {
  return prisma.productGroup.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, include: withCount })
}

async function getActiveGroup(id: string) {
  const group = await prisma.productGroup.findFirst({ where: { id, deletedAt: null } })
  if (!group) throw new Error("El producto base no existe")
  return group
}

// Quitar un atributo que sus variantes ya usan dejaría variantes que no se distinguen: no se permite
export async function updateProductGroup(id: string, input: ProductGroupInput, userId: string) {
  const current = await getActiveGroup(id)
  await assertUniqueName(input.name, id)
  const removed = current.attributeNames.filter((a) => !input.attributeNames.includes(a))
  if (removed.length && (await prisma.product.count({ where: { groupId: id, deletedAt: null } })) > 0) {
    throw new Error(`No se puede quitar ${removed.map((r) => `"${r}"`).join(", ")}: hay variantes que lo usan`)
  }
  const group = await prisma.productGroup.update({
    where: { id },
    data: { name: input.name, attributeNames: input.attributeNames },
    include: withCount,
  })
  await logAudit(userId, "UPDATE", "ProductGroup", id, { ...input })
  return group
}

// Borrar el producto base no borra las variantes: quedan como productos sueltos (conservan sus atributos)
export async function deleteProductGroup(id: string, userId: string) {
  await getActiveGroup(id)
  await prisma.$transaction(async (tx) => {
    await tx.product.updateMany({ where: { groupId: id }, data: { groupId: null } })
    await tx.productGroup.update({ where: { id }, data: { deletedAt: new Date() } })
    await logAudit(userId, "DELETE", "ProductGroup", id, undefined, tx)
  })
}

// Valida la variante de un producto: el grupo existe, trae un valor para cada atributo del grupo
// (y nada más) y no repite la combinación de otra variante activa del mismo grupo.
export async function normalizeVariant(
  groupId: string | null | undefined,
  attributes: Record<string, string> | null | undefined,
  exceptProductId?: string,
  client: Db = prisma
): Promise<{ groupId: string | null; attributes: Record<string, string> | null }> {
  if (!groupId) return { groupId: null, attributes: attributes && Object.keys(attributes).length ? attributes : null }
  const group = await client.productGroup.findFirst({ where: { id: groupId, deletedAt: null } })
  if (!group) throw new Error("El producto base no existe")

  const values: Record<string, string> = {}
  for (const name of group.attributeNames) {
    const v = attributes?.[name]?.trim()
    if (!v) throw new Error(`Falta el valor de "${name}" para esta variante`)
    values[name] = v
  }
  const extra = Object.keys(attributes ?? {}).filter((k) => !group.attributeNames.includes(k))
  if (extra.length) throw new Error(`"${extra.join('", "')}" no es un atributo de ${group.name}`)

  const siblings = await client.product.findMany({
    where: { groupId, deletedAt: null, ...(exceptProductId && { id: { not: exceptProductId } }) },
    select: { name: true, attributes: true },
  })
  const key = (a: Record<string, string>) => group.attributeNames.map((n) => (a[n] ?? "").toLowerCase()).join("|")
  const twin = siblings.find((s) => s.attributes && key(s.attributes as Record<string, string>) === key(values))
  if (twin) throw new Error(`Ya existe esa variante de ${group.name}: ${twin.name}`)

  return { groupId, attributes: values }
}

import { prisma } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts";
import type { SupplierInput } from "./supplier.schema.ts";
import { catalogResult, contains, type CatalogQuery } from "../../shared/pagination.ts";
import type { Prisma } from "../../generated/prisma/client.ts";

// crear y editar mandan el proveedor completo ("" o ausente = sin dato)
const toData = ({ name, email, phone, address, idType, idNumber }: SupplierInput) => ({
  name,
  email: email || null,
  phone: phone || null,
  address: address || null,
  idType: idNumber ? (idType ?? null) : null,
  idNumber: idNumber || null,
})

export async function createSupplier(input: SupplierInput) {
  const { name } = input
  const existingSupplier = await prisma.supplier.findFirst({ where: { name } })

  if (existingSupplier) {
    throw new Error("El proveedor ya existe en el sistema")
  }

  const newSupplier = await prisma.supplier.create({
    data: { companyId: currentCompanyId(), ...toData(input) },
  })

  return newSupplier
}

// Sin page: lista completa (selectores). _count en vez de traer todos los productos de cada proveedor.
export function listSuppliers(f: CatalogQuery) {
  const where: Prisma.SupplierWhereInput = f.q
    ? { OR: [{ name: contains(f.q) }, { email: contains(f.q) }, { idNumber: { startsWith: f.q.replace(/[\s-]/g, "") } }] }
    : {}
  return catalogResult(
    f,
    () => prisma.supplier.count({ where }),
    (page) => prisma.supplier.findMany({
      where,
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: { name: "asc" },
      ...page,
    })
  )
}

export async function getSupplierById(id: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: { products: true },
  })

  if (!supplier) {
    throw new Error("Proveedor no encontrado")
  }

  return supplier
}

export async function updateSupplier(id: string, input: SupplierInput) {
  const updatedSupplier = await prisma.supplier.update({
    where: { id },
    data: toData(input),
  })

  return updatedSupplier
}

export async function deleteSupplier(id: string) {
  const deletedSupplier = await prisma.supplier.delete({ where: { id } })
  return deletedSupplier
}
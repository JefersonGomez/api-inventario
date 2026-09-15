import { prisma } from "../../config/database.ts"

export async function createSupplier(
  name: string,
  email: string | undefined,
  phone: string | undefined,
  address: string | undefined
) {
  const existingSupplier = await prisma.supplier.findUnique({ where: { name } })

  if (existingSupplier) {
    throw new Error("El proveedor ya existe en el sistema")
  }

  const newSupplier = await prisma.supplier.create({
    data: {
      name,
      email: email ?? null,
      phone: phone ?? null,
      address: address ?? null,
    },
  })

  return newSupplier
}

export async function getAllSuppliers() {
  const suppliers = await prisma.supplier.findMany({
    include: { products: true },
  })

  return suppliers
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

export async function updateSupplier(
  id: string,
  name: string,
  email: string | undefined,
  phone: string | undefined,
  address: string | undefined
) {
  const updatedSupplier = await prisma.supplier.update({
    where: { id },
    data: {
      name,
      email: email ?? null,
      phone: phone ?? null,
      address: address ?? null,
    },
  })

  return updatedSupplier
}

export async function deleteSupplier(id: string) {
  const deletedSupplier = await prisma.supplier.delete({ where: { id } })
  return deletedSupplier
}
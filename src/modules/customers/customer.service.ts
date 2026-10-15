import { prisma } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { logAudit } from "../audit/audit.service.ts"
import type { CustomerInput } from "./customer.schema.ts"

// Crear y editar mandan el cliente completo ("" o ausente = sin dato)
function toData(input: CustomerInput) {
  return {
    name: input.name,
    idType: input.idNumber ? (input.idType ?? null) : null,
    idNumber: input.idNumber || null,
    email: input.email || null,
    phone: input.phone || null,
    address: input.address || null,
    economicActivity: input.economicActivity || null,
    creditLimit: input.creditLimit ?? null,
    // sin límite de crédito no hay plazo
    creditDays: input.creditLimit == null ? null : (input.creditDays ?? null),
  }
}

// la identificación es única por empresa entre los clientes activos (también hay índice parcial en la base)
async function assertUniqueId(idType: string | null | undefined, idNumber: string | null | undefined, exceptId?: string) {
  if (!idType || !idNumber) return
  const other = await prisma.customer.findFirst({
    where: { idType: idType as never, idNumber, deletedAt: null, ...(exceptId && { id: { not: exceptId } }) },
    select: { name: true },
  })
  if (other) throw new Error(`Ya existe un cliente con esa identificación: ${other.name}`)
}

export async function createCustomer(input: CustomerInput, userId: string) {
  const data = toData(input)
  await assertUniqueId(data.idType, data.idNumber)
  const customer = await prisma.customer.create({ data: { ...data, companyId: currentCompanyId() } })
  await logAudit(userId, "CREATE", "Customer", customer.id, { name: customer.name })
  return customer
}

export function getCustomers() {
  return prisma.customer.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } })
}

export async function getCustomerById(id: string) {
  const customer = await prisma.customer.findFirst({ where: { id, deletedAt: null } })
  if (!customer) throw new Error("Cliente no encontrado")
  return customer
}

export async function updateCustomer(id: string, input: CustomerInput, userId: string) {
  await getCustomerById(id)
  const data = toData(input)
  await assertUniqueId(data.idType, data.idNumber, id)
  const customer = await prisma.customer.update({ where: { id }, data })
  await logAudit(userId, "UPDATE", "Customer", id, data as never)
  return customer
}

// soft delete: los comprobantes emitidos a su nombre lo siguen referenciando
export async function deleteCustomer(id: string, userId: string) {
  await getCustomerById(id)
  await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } })
  await logAudit(userId, "DELETE", "Customer", id)
}

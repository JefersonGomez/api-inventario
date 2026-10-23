// Sucursales y bodegas (Bloque 4). La sucursal vende (tiene cajas y su código de 3 dígitos en los
// comprobantes); la bodega solo almacena. No se borran: se desactivan, y solo si ya no tienen stock.
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { activeLocationId, allowedLocationIds, assertLocationAllowed, currentCompanyId, locationScope } from "../../shared/tenant.ts"
import { getCompany } from "../company/company.service.ts"
import { logAudit } from "../audit/audit.service.ts"
import { sinpeFields } from "../../shared/sinpe.ts"

// La que nace con cada empresa (registro, otra empresa, tests)
export const MAIN_LOCATION = (companyId: string) => ({
  companyId, name: "Sucursal principal", type: "BRANCH" as const, code: "001",
})

const text = (max: number) => z.string().trim().max(max)
export const locationSchema = z.object({
  name: text(80).min(1, "El nombre es obligatorio"),
  type: z.enum(["BRANCH", "WAREHOUSE"]),
  address: text(250).nullable().optional(),
  ...sinpeFields, // SINPE Móvil de la sucursal (si no tiene, la caja usa el general de la empresa)
})
export const updateLocationSchema = locationSchema.partial().extend({ isActive: z.boolean().optional() })
export type LocationInput = z.infer<typeof locationSchema>
export type LocationUpdate = z.infer<typeof updateLocationSchema>

// Las que ve la persona (las suyas; el admin, todas). Con inactive también las desactivadas.
export function listLocations(inactive = false) {
  const allowed = allowedLocationIds() // el selector lista todas las suyas, aunque haya una activa
  return prisma.location.findMany({
    where: {
      ...(!inactive && { isActive: true }),
      ...(allowed && { id: { in: allowed } }),
    },
    orderBy: [{ type: "asc" }, { code: "asc" }, { name: "asc" }],
  })
}

async function assertBranchSlot() {
  const { maxBranches } = (await getCompany()).limits
  if (maxBranches !== null && (await prisma.location.count({ where: { type: "BRANCH", isActive: true } })) >= maxBranches) {
    throw new Error(`Tu plan permite ${maxBranches} sucursal(es). Mejora tu plan para abrir más (las bodegas no tienen límite).`)
  }
}

// Siguiente código de sucursal: 001, 002… (Hacienda: 3 dígitos)
async function nextBranchCode() {
  const codes = await prisma.location.findMany({ where: { code: { not: null } }, select: { code: true } })
  const max = Math.max(0, ...codes.map((c) => Number(c.code)))
  if (max >= 999) throw new Error("No quedan códigos de sucursal")
  return String(max + 1).padStart(3, "0")
}

export async function createLocation(input: LocationInput, userId: string) {
  if (input.type === "BRANCH") await assertBranchSlot()
  const location = await prisma.location.create({
    data: {
      companyId: currentCompanyId(),
      name: input.name,
      type: input.type,
      address: input.address || null,
      sinpeNumber: input.sinpeNumber || null,
      sinpeName: input.sinpeName || null,
      code: input.type === "BRANCH" ? await nextBranchCode() : null,
    },
  })
  await logAudit(userId, "CREATE", "Location", location.id, { name: location.name, type: location.type })
  return location
}

export async function updateLocation(id: string, input: LocationUpdate, userId: string) {
  const current = await prisma.location.findFirst({ where: { id } })
  if (!current) throw new Error("Ubicación no encontrada")
  const type = input.type ?? current.type
  const activating = input.isActive === true && !current.isActive
  const deactivating = input.isActive === false && current.isActive

  if (type === "BRANCH" && (activating || (current.type === "WAREHOUSE" && input.type === "BRANCH" && current.isActive))) {
    await assertBranchSlot()
  }
  if (deactivating) {
    const withStock = await prisma.productStock.count({ where: { locationId: id, quantity: { not: 0 } } })
    if (withStock > 0) throw new Error("Todavía tiene stock: pásalo a otra ubicación antes de desactivarla")
    const open = await prisma.stockTransfer.count({
      where: { status: "IN_TRANSIT", OR: [{ fromLocationId: id }, { toLocationId: id }] },
    })
    if (open > 0) throw new Error("Tiene transferencias en tránsito: recíbelas o cancélalas antes")
    if ((await prisma.purchaseOrder.count({ where: { locationId: id, status: { in: ["PENDING", "PARTIAL"] } } })) > 0) {
      throw new Error("Tiene órdenes de compra por recibir: recíbelas o cancélalas antes")
    }
    if ((await prisma.location.count({ where: { isActive: true } })) <= 1) {
      throw new Error("La empresa necesita al menos una ubicación activa")
    }
  }
  const updated = await prisma.location.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.address !== undefined && { address: input.address || null }),
      ...(input.sinpeNumber !== undefined && { sinpeNumber: input.sinpeNumber || null }),
      ...(input.sinpeName !== undefined && { sinpeName: input.sinpeName || null }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.type !== undefined && {
        type,
        // al pasar a sucursal toma código; una bodega no lo usa (el código queda reservado si lo tenía)
        ...(type === "BRANCH" && !current.code && { code: await nextBranchCode() }),
      }),
    },
  })
  await logAudit(userId, "UPDATE", "Location", id, input)
  return updated
}

// Ubicación donde registrar algo: la indicada o la activa; si la persona trabaja en varias y no
// eligió, la primera sucursal activa (normalmente la principal). Valida que exista y que trabaje ahí.
export async function resolveLocation(locationId?: string | null) {
  const scope = locationScope()
  const id = locationId ?? activeLocationId()
  const location = await prisma.location.findFirst({
    where: {
      isActive: true,
      ...(id ? { id } : scope ? { id: { in: scope } } : {}),
    },
    orderBy: [{ type: "asc" }, { code: "asc" }],
  })
  if (!location) throw new Error(id ? "La ubicación no existe o está desactivada" : "No hay una ubicación activa")
  assertLocationAllowed(location.id)
  return location
}

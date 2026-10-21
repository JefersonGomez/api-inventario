import type { Role } from "../generated/prisma/enums.ts"

// Permisos del sistema. Cada ruta pide uno (middleware Can) y el frontend oculta lo que no se puede.
// Las claves son estables: se guardan en Membership.grantedPermissions / revokedPermissions.
export const PERMISSIONS = [
  "products.manage", // crear, editar y borrar productos, categorías y productos base; importar
  "costs.view", // ver costos, márgenes y valor del inventario a costo
  "stock.move", // registrar movimientos de stock a mano
  "purchases.request", // pedir mercadería (solicitudes de compra)
  "purchases.manage", // aprobar/rechazar solicitudes, órdenes de compra, recibirlas y enviarlas
  "suppliers.manage", // crear, editar y borrar proveedores
  "customers.manage", // registrar y editar clientes
  "customers.delete", // borrar clientes
  "reports.view", // reportes
  "audit.view", // registro de auditoría
  "users.manage", // usuarios, invitaciones, roles y permisos
  "company.manage", // datos de la empresa, moneda y datos fiscales
  "sales.sell", // vender en la caja (Bloque 7)
  "cash.manage", // abrir y cerrar su caja (Bloque 7)
  "cash.reconcile", // jefa de caja: hacer el arqueo de los cierres y ver el efectivo esperado
  "sales.discount", // descuentos sobre el tope del cajero; autoriza con su PIN
  "sales.void", // anular ventas y hacer devoluciones; autoriza con su PIN
  "sales.negative", // autorizar negativas: vender lo que el sistema tiene sin stock (descuadre); con su PIN
  "sales.credit", // autorizar ventas a crédito en la caja; con su PIN
  "credit.manage", // habilitar crédito a un cliente y fijar su límite (por defecto solo el admin)
  "receivables.manage", // cuentas por cobrar: ver saldos y registrar abonos sin caja
  "accounting.view", // contabilidad (Bloques 10 y 11)
] as const
export type Permission = (typeof PERMISSIONS)[number]

// Permisos que una persona puede usar para autorizar en la caja con su PIN
export const AUTHORIZING_PERMISSIONS: Permission[] = ["sales.discount", "sales.void", "sales.negative", "sales.credit"]

// Quién necesita código de caja: quien abre caja o autoriza con PIN
export const needsPin = (perms: readonly string[]) =>
  perms.includes("cash.manage") || AUTHORIZING_PERMISSIONS.some((p) => perms.includes(p))
export const canAuthorize = (perms: readonly string[]) => AUTHORIZING_PERMISSIONS.some((p) => perms.includes(p))

// Lo que trae cada rol. EMPLOYE (Bodega) conserva exactamente lo que podía hacer antes de los roles finos.
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  MANAGER: [
    "products.manage", "costs.view", "stock.move", "purchases.request", "purchases.manage", "suppliers.manage",
    "customers.manage", "customers.delete", "reports.view", "audit.view", "sales.sell", "cash.manage",
    "cash.reconcile", "sales.discount", "sales.void", "sales.negative", "sales.credit", "receivables.manage", "accounting.view",
  ],
  EMPLOYE: ["costs.view", "stock.move", "purchases.request", "customers.manage", "reports.view"],
  CASHIER: ["purchases.request", "customers.manage", "sales.sell", "cash.manage"],
  ACCOUNTANT: ["costs.view", "reports.view", "audit.view", "accounting.view", "receivables.manage"],
}

// Rol + ajustes de la persona. Al ADMIN no se le puede quitar nada (nadie queda fuera de su empresa).
export function effectivePermissions(role: Role, granted: string[] = [], revoked: string[] = []): Permission[] {
  if (role === "ADMIN") return [...PERMISSIONS]
  const set = new Set<Permission>(ROLE_PERMISSIONS[role])
  for (const p of granted) if ((PERMISSIONS as readonly string[]).includes(p)) set.add(p as Permission)
  for (const p of revoked) set.delete(p as Permission)
  return PERMISSIONS.filter((p) => set.has(p))
}

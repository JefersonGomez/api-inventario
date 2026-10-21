import { PrismaClient, Prisma } from "../generated/prisma/client.ts"
import { PrismaPg } from "@prisma/adapter-pg"
import { currentCompanyId } from "../shared/tenant.ts"

// Los Decimal (precio, costo, stock, cantidades) salen en el JSON como número, no como texto:
// el frontend compara y suma stock, y "10.000" <= "5.000" daría verdadero comparando texto.
// Los montos y cantidades del sistema caben de sobra en la precisión de un number.
;(Prisma.Decimal.prototype as unknown as { toJSON(): number }).toJSON = function (this: Prisma.Decimal) {
  return this.toNumber()
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })

// Sin filtro por empresa: solo para auth, datos de plataforma (usuarios, empresas, membresías),
// el seed y los tests. El código de negocio usa `prisma`.
export const prismaRoot = new PrismaClient({ adapter })

// Modelos que pertenecen a una empresa (tienen companyId)
const TENANT_MODELS = new Set([
  "Category", "Supplier", "Product", "StockMovement",
  "PurchaseRequest", "PurchaseOrder", "AuditLog", "Notification", "Invitation",
  "ProductGroup", "Customer", "Document", "DocumentSequence",
  "Location", "ProductStock", "StockTransfer", "StockCount", "ProductLot", "DailySummary",
  "CashRegister", "CashSession", "CashMovement", "StockNegative", "DiscountType",
  "Installment", "CustomerPayment",
  // DocumentLine y DocumentPayment no tienen companyId: se crean y leen siempre a través de su Document
])

type Data = Record<string, unknown>

function stamp(data: Data, companyId: string): Data {
  if (data.companyId !== undefined && data.companyId !== companyId) {
    throw new Error("Intento de escribir en otra empresa")
  }
  return { ...data, companyId }
}

// Cliente de negocio: toda lectura/escritura de un modelo de empresa queda limitada a la
// empresa activa (where.companyId en lecturas/updates/deletes, data.companyId en creates).
// Sin empresa activa, la operación falla en vez de ver datos de todas.
export const prisma = prismaRoot.$extends({
  name: "tenant",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_MODELS.has(model)) return query(args)
        const companyId = currentCompanyId()
        const a = { ...(args as Data) }
        switch (operation) {
          case "create":
            a.data = stamp(a.data as Data, companyId)
            break
          case "createMany":
          case "createManyAndReturn":
            a.data = Array.isArray(a.data)
              ? (a.data as Data[]).map((d) => stamp(d, companyId))
              : stamp(a.data as Data, companyId)
            break
          case "upsert":
            a.where = { ...(a.where as Data), companyId }
            a.create = stamp(a.create as Data, companyId)
            break
          default:
            a.where = { ...(a.where as Data), companyId }
        }
        return query(a as typeof args)
      },
    },
  },
})

export type PrismaClientScoped = typeof prisma

// Cliente filtrado o una transacción abierta con él (para funciones que aceptan `tx`)
type ScopedTx = Parameters<Extract<Parameters<PrismaClientScoped["$transaction"]>[0], (...args: never[]) => unknown>>[0]
export type Db = PrismaClientScoped | ScopedTx

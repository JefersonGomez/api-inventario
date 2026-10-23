// Demo pública (D4, decisiones del usuario del 23-oct-2026): una ferretería de ejemplo con ~60 días de
// actividad para mostrar el proyecto. resetDemo() borra SOLO la empresa demo (Company.isDemo) y sus usuarios
// (User.isDemo) y la vuelve a crear; corre cada noche con un cron en la VPS (`npm run demo:reset`).
//
// Las ventas se hacen con los mismos servicios de la app (abrir caja, vender, devolver, abonar, cerrar,
// arquear), así todo cuadra igual que en uso real; después cada turno se "lleva" a su día en el pasado.
// Los comprobantes son inmutables (trigger): para borrarlos o fecharlos se usa
// `session_replication_role = replica` dentro de la transacción, que apaga triggers y llaves foráneas
// SOLO en esa conexión y SOLO para las filas de la empresa demo. Requiere que el usuario de Postgres sea
// superusuario (lo es el de docker-compose).
import bcrypt from "bcrypt"
import { prismaRoot, prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import type { UnitOfMeasure } from "../../generated/prisma/enums.ts"
import { runWithCompany } from "../../shared/tenant.ts"
import { createMovement } from "../movements/movements.service.ts"
import { closeSession, openSession, reconcileSession, sell, sessionSummary, addCashMovement } from "../pos/pos.service.ts"
import { createReturn } from "../sales/sales.service.ts"
import { registerPayment, setCreditLimit, creditStatus } from "../receivables/receivables.service.ts"
import { createPurchaseOrder, receivePurchaseOrder } from "../purchase-orders/purchase-order.service.ts"
import { effectivePermissions } from "../../config/permissions.ts"

const DAY = 86_400_000
// códigos de caja que la demo muestra en pantalla (los usa quien prueba la caja)
export const DEMO_CODES = { cashier: "2468", manager: "9753" } as const

// ---------- Datos de la ferretería ----------

type P = { sku: string; name: string; unit: UnitOfMeasure; price: number; cost: number; cat: string; min: number; stock: [number, number, number]; weight: number }
const CATEGORIES = ["Herramientas", "Tornillería", "Electricidad", "Fontanería", "Pinturas", "Construcción", "Jardín y seguridad"]
// stock: [Sucursal Centro, Sucursal Heredia, Bodega]; weight: qué tanto se vende. Nivel, breaker y pintura
// anticorrosiva tienen el mínimo alto a propósito: la demo muestra alertas de stock bajo
const PRODUCTS: P[] = [
  { sku: "MRT-16", name: "Martillo de uña 16 oz", unit: "UNIT", price: 6500, cost: 3800, cat: "Herramientas", min: 5, stock: [25, 12, 30], weight: 3 },
  { sku: "DST-6", name: "Juego de destornilladores 6 piezas", unit: "UNIT", price: 8900, cost: 5200, cat: "Herramientas", min: 4, stock: [18, 8, 20], weight: 2 },
  { sku: "CNT-5M", name: "Cinta métrica 5 m", unit: "UNIT", price: 3200, cost: 1700, cat: "Herramientas", min: 6, stock: [30, 15, 40], weight: 3 },
  { sku: "ALC-8", name: "Alicate universal 8\"", unit: "UNIT", price: 5400, cost: 3100, cat: "Herramientas", min: 5, stock: [20, 10, 25], weight: 2 },
  { sku: "LLV-10", name: "Llave ajustable 10\"", unit: "UNIT", price: 6200, cost: 3600, cat: "Herramientas", min: 4, stock: [16, 8, 20], weight: 2 },
  { sku: "TAL-650", name: "Taladro percutor 650 W", unit: "UNIT", price: 38500, cost: 24000, cat: "Herramientas", min: 2, stock: [8, 4, 10], weight: 1 },
  { sku: "BRC-CON", name: "Juego de brocas para concreto", unit: "UNIT", price: 7900, cost: 4300, cat: "Herramientas", min: 3, stock: [14, 6, 15], weight: 1 },
  { sku: "SRR-ARC", name: "Sierra de arco", unit: "UNIT", price: 4800, cost: 2600, cat: "Herramientas", min: 3, stock: [12, 6, 12], weight: 1 },
  { sku: "NVL-60", name: "Nivel de aluminio 60 cm", unit: "UNIT", price: 7400, cost: 4200, cat: "Herramientas", min: 30, stock: [10, 5, 12], weight: 1 },
  { sku: "CLV-2", name: "Clavo de 2\" (kg)", unit: "KG", price: 1800, cost: 950, cat: "Tornillería", min: 20, stock: [120, 60, 200], weight: 5 },
  { sku: "CLV-3", name: "Clavo de 3\" (kg)", unit: "KG", price: 1800, cost: 950, cat: "Tornillería", min: 20, stock: [120, 60, 200], weight: 4 },
  { sku: "TRN-GYP", name: "Tornillo gypsum 1\" (caja de 100)", unit: "UNIT", price: 2100, cost: 1100, cat: "Tornillería", min: 10, stock: [60, 30, 80], weight: 4 },
  { sku: "TRN-MAD", name: "Tornillo para madera 2\" (caja de 50)", unit: "UNIT", price: 2600, cost: 1350, cat: "Tornillería", min: 10, stock: [50, 25, 70], weight: 3 },
  { sku: "TCO-14", name: "Tacos fisher 1/4\" (bolsa de 50)", unit: "UNIT", price: 1500, cost: 700, cat: "Tornillería", min: 10, stock: [60, 30, 80], weight: 4 },
  { sku: "ARN-38", name: "Arandela plana 3/8\" (bolsa de 50)", unit: "UNIT", price: 1200, cost: 550, cat: "Tornillería", min: 8, stock: [40, 20, 50], weight: 2 },
  { sku: "CBL-12", name: "Cable THHN #12 (metro)", unit: "M", price: 650, cost: 360, cat: "Electricidad", min: 100, stock: [900, 450, 1500], weight: 5 },
  { sku: "CBL-14", name: "Cable THHN #14 (metro)", unit: "M", price: 480, cost: 260, cat: "Electricidad", min: 100, stock: [900, 450, 1500], weight: 4 },
  { sku: "TMC-DBL", name: "Tomacorriente doble", unit: "UNIT", price: 1900, cost: 950, cat: "Electricidad", min: 10, stock: [50, 25, 60], weight: 3 },
  { sku: "APG-SEN", name: "Apagador sencillo", unit: "UNIT", price: 1600, cost: 800, cat: "Electricidad", min: 10, stock: [45, 20, 60], weight: 3 },
  { sku: "BMB-9W", name: "Bombillo LED 9 W", unit: "UNIT", price: 1450, cost: 700, cat: "Electricidad", min: 15, stock: [80, 40, 100], weight: 4 },
  { sku: "CNT-AIS", name: "Cinta aislante", unit: "UNIT", price: 900, cost: 400, cat: "Electricidad", min: 15, stock: [70, 35, 90], weight: 4 },
  { sku: "BRK-20", name: "Breaker 20 A", unit: "UNIT", price: 6900, cost: 4100, cat: "Electricidad", min: 50, stock: [16, 8, 20], weight: 1 },
  { sku: "PVC-12", name: "Tubo PVC 1/2\" (6 m)", unit: "UNIT", price: 3900, cost: 2300, cat: "Fontanería", min: 10, stock: [50, 25, 80], weight: 3 },
  { sku: "CDO-12", name: "Codo PVC 1/2\"", unit: "UNIT", price: 350, cost: 150, cat: "Fontanería", min: 30, stock: [200, 100, 300], weight: 4 },
  { sku: "PGM-PVC", name: "Pegamento para PVC 1/4 gal", unit: "UNIT", price: 5600, cost: 3200, cat: "Fontanería", min: 4, stock: [16, 8, 20], weight: 2 },
  { sku: "LLP-12", name: "Llave de paso 1/2\"", unit: "UNIT", price: 4300, cost: 2400, cat: "Fontanería", min: 5, stock: [20, 10, 25], weight: 2 },
  { sku: "TFL-CNT", name: "Cinta teflón", unit: "UNIT", price: 600, cost: 250, cat: "Fontanería", min: 20, stock: [90, 45, 120], weight: 4 },
  { sku: "PNT-BLA", name: "Pintura látex blanca (galón)", unit: "UNIT", price: 14900, cost: 9200, cat: "Pinturas", min: 6, stock: [24, 12, 40], weight: 2 },
  { sku: "PNT-ANT", name: "Pintura anticorrosiva gris (galón)", unit: "UNIT", price: 17900, cost: 11000, cat: "Pinturas", min: 45, stock: [14, 7, 20], weight: 1 },
  { sku: "BRC-3", name: "Brocha de 3\"", unit: "UNIT", price: 2200, cost: 1100, cat: "Pinturas", min: 8, stock: [35, 18, 40], weight: 3 },
  { sku: "RDL-9", name: "Rodillo de 9\"", unit: "UNIT", price: 3600, cost: 1900, cat: "Pinturas", min: 6, stock: [25, 12, 30], weight: 2 },
  { sku: "THN-L", name: "Thinner (litro)", unit: "L", price: 2400, cost: 1300, cat: "Pinturas", min: 10, stock: [60, 30, 80], weight: 2 },
  { sku: "LJA-120", name: "Lija de agua #120", unit: "UNIT", price: 450, cost: 200, cat: "Pinturas", min: 30, stock: [150, 75, 200], weight: 3 },
  { sku: "CMT-50", name: "Cemento gris 50 kg", unit: "UNIT", price: 7900, cost: 6200, cat: "Construcción", min: 20, stock: [120, 60, 250], weight: 4 },
  { sku: "ARN-40", name: "Arena (saco de 40 kg)", unit: "UNIT", price: 2900, cost: 1800, cat: "Construcción", min: 20, stock: [100, 50, 200], weight: 3 },
  { sku: "VRL-38", name: "Varilla corrugada 3/8\" (6 m)", unit: "UNIT", price: 3600, cost: 2500, cat: "Construcción", min: 30, stock: [150, 70, 300], weight: 3 },
  { sku: "ALM-NEG", name: "Alambre negro (kg)", unit: "KG", price: 2300, cost: 1400, cat: "Construcción", min: 15, stock: [80, 40, 120], weight: 2 },
  { sku: "MLL-GLV", name: "Malla galvanizada (metro)", unit: "M", price: 1900, cost: 1100, cat: "Construcción", min: 30, stock: [200, 100, 300], weight: 2 },
  { sku: "MNG-15", name: "Manguera para jardín 15 m", unit: "UNIT", price: 11900, cost: 7000, cat: "Jardín y seguridad", min: 3, stock: [12, 6, 15], weight: 1 },
  { sku: "PLA-CUA", name: "Pala cuadrada", unit: "UNIT", price: 9800, cost: 6000, cat: "Jardín y seguridad", min: 3, stock: [10, 0, 12], weight: 1 },
  { sku: "GNT-TRB", name: "Guantes de trabajo", unit: "UNIT", price: 2500, cost: 1200, cat: "Jardín y seguridad", min: 10, stock: [40, 20, 50], weight: 3 },
  { sku: "LNT-SEG", name: "Lentes de seguridad", unit: "UNIT", price: 2800, cost: 1300, cat: "Jardín y seguridad", min: 6, stock: [25, 12, 30], weight: 2 },
]
// CABYS por categoría (13 dígitos; de ejemplo)
const CABYS: Record<string, string> = {
  Herramientas: "4291100000100", Tornillería: "4299400000000", Electricidad: "4632100000000", Fontanería: "3632100000000",
  Pinturas: "3511000000100", Construcción: "3744000000000", "Jardín y seguridad": "4292100000000",
}
const SUPPLIERS = [
  { name: "Distribuidora Ferretera del Valle", idType: "JURIDICA" as const, idNumber: "3101234567", email: "ventas@ferredelvalle.demo", phone: "2222-1100" },
  { name: "Eléctricos Centroamericanos", idType: "JURIDICA" as const, idNumber: "3101345678", email: "pedidos@electricosca.demo", phone: "2233-4400" },
  { name: "Pinturas Tropicales", idType: "JURIDICA" as const, idNumber: "3101456780", email: "ventas@pinturastropicales.demo", phone: "2244-5500" },
  { name: "Cementos y Agregados del Norte", idType: "JURIDICA" as const, idNumber: "3101567891", email: "despacho@cementosnorte.demo", phone: "2455-6600" },
]
// crédito = límite (null = de contado)
const CUSTOMERS = [
  { name: "Constructora Montes S.A.", idType: "JURIDICA" as const, idNumber: "3101678912", credit: 900000 },
  { name: "Remodelaciones Vargas", idType: "FISICA" as const, idNumber: "112340567", credit: 350000 },
  { name: "José Rodríguez Solano", idType: "FISICA" as const, idNumber: "205550222", credit: 150000 },
  { name: "Taller Eléctrico Brenes", idType: "JURIDICA" as const, idNumber: "3101789123", credit: 450000 },
  { name: "María Fernández Castro", idType: "FISICA" as const, idNumber: "109870654", credit: null },
  { name: "Condominio Las Palmas", idType: "JURIDICA" as const, idNumber: "3102890234", credit: null },
]

// generador pseudoaleatorio con semilla: la demo sale igual cada noche (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- Borrar la demo anterior ----------

async function wipeDemo() {
  const companies = (await prismaRoot.company.findMany({ where: { isDemo: true }, select: { id: true } })).map((c) => c.id)
  const users = (await prismaRoot.user.findMany({ where: { isDemo: true }, select: { id: true } })).map((u) => u.id)
  if (!companies.length && !users.length) return
  const tables = await prismaRoot.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'companyId'`
  const ids = Prisma.join(companies.length ? companies : ["-"])
  await prismaRoot.$transaction(async (tx) => {
    // apaga triggers (comprobantes inmutables) y llaves foráneas solo en esta transacción
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`
    // primero las tablas hijas sin companyId (se buscan por su padre)
    await tx.$executeRaw`DELETE FROM "DocumentLine" WHERE "documentId" IN (SELECT id FROM "Document" WHERE "companyId" IN (${ids}))`
    await tx.$executeRaw`DELETE FROM "DocumentPayment" WHERE "documentId" IN (SELECT id FROM "Document" WHERE "companyId" IN (${ids}))`
    await tx.$executeRaw`DELETE FROM "PurchaseOrderItem" WHERE "purchaseOrderId" IN (SELECT id FROM "PurchaseOrder" WHERE "companyId" IN (${ids}))`
    await tx.$executeRaw`DELETE FROM "StockTransferItem" WHERE "transferId" IN (SELECT id FROM "StockTransfer" WHERE "companyId" IN (${ids}))`
    await tx.$executeRaw`DELETE FROM "StockCountItem" WHERE "countId" IN (SELECT id FROM "StockCount" WHERE "companyId" IN (${ids}))`
    await tx.$executeRaw`DELETE FROM "Comment" WHERE "purchaseRequestId" IN (SELECT id FROM "PurchaseRequest" WHERE "companyId" IN (${ids}))
      OR "purchaseOrderId" IN (SELECT id FROM "PurchaseOrder" WHERE "companyId" IN (${ids}))`
    for (const { table_name } of tables) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "companyId" = ANY($1::text[])`, companies)
    }
    for (const id of companies) await tx.$executeRaw`DELETE FROM "PlatformSetting" WHERE key LIKE ${`%${id}%`}`
    await tx.$executeRaw`DELETE FROM "Company" WHERE "isDemo" = true`
    await tx.$executeRaw`DELETE FROM "User" WHERE "isDemo" = true`
  })
}

// ---------- Crear la demo ----------

type Actor = { id: string; permissions: string[] }
const actorOf = (id: string, role: "ADMIN" | "MANAGER" | "CASHIER"): Actor => ({ id, permissions: effectivePermissions(role) })
const round2 = (v: number) => Math.round(v * 100) / 100

// Lleva un turno ya cerrado a su día: comprobantes repartidos de 8:00 a 18:00 y lo que cuelga de ellos
async function backdateSession(sessionId: string, day: Date, daysAgo: number) {
  const docs = await prismaRoot.document.findMany({ where: { cashSessionId: sessionId }, orderBy: { issuedAt: "asc" }, select: { id: true } })
  const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
  await prismaRoot.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`
    for (const [i, d] of docs.entries()) {
      const t = new Date(at(8).getTime() + Math.round(((i + 0.5) / docs.length) * 10 * 3_600_000))
      await tx.$executeRaw`UPDATE "Document" SET "issuedAt" = ${t} WHERE id = ${d.id}`
      await tx.$executeRaw`UPDATE "StockMovement" SET "createdAt" = ${t} WHERE "sourceId" = ${d.id}`
      await tx.$executeRaw`UPDATE "StockNegative" SET "createdAt" = ${t} WHERE "documentId" = ${d.id}`
      // las cuotas se calcularon desde hoy: se corren los mismos días que la venta
      await tx.$executeRaw`UPDATE "Installment" SET "dueDate" = "dueDate" - ${daysAgo}::int WHERE "documentId" = ${d.id}`
    }
    await tx.$executeRaw`UPDATE "CashSession" SET "openedAt" = ${at(7, 45)}, "closedAt" = ${at(18, 30)},
      "reconciledAt" = CASE WHEN "reconciledAt" IS NULL THEN NULL ELSE ${at(18, 45)}::timestamp END WHERE id = ${sessionId}`
    await tx.$executeRaw`UPDATE "CashMovement" SET "createdAt" = ${at(13)} WHERE "sessionId" = ${sessionId}`
    await tx.$executeRaw`UPDATE "CustomerPayment" SET "createdAt" = ${at(11)} WHERE "cashSessionId" = ${sessionId}`
  })
}

// Conteo de billetes y monedas que suma un monto (para el arqueo)
function countFor(amount: number) {
  const den = [50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5] // billetes y monedas de colones
  const out: Record<string, number> = {}
  let left = Math.round(amount)
  for (const d of den) {
    const n = Math.floor(left / d)
    if (n > 0) {
      out[String(d)] = n
      left -= n * d
    }
  }
  return out
}

export async function resetDemo(opts: { days?: number; log?: (m: string) => void } = {}) {
  const days = opts.days ?? 60
  const log = opts.log ?? (() => {})
  const random = rng(20261023)
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!
  log("borrando la demo anterior…")
  await wipeDemo()

  // ----- empresa y personas -----
  log("creando la empresa y el equipo…")
  const hash = (v: string) => bcrypt.hash(v, 10)
  const noLogin = await hash(crypto.randomUUID()) // nadie entra con contraseña: se entra con el botón de la demo
  const mkUser = (name: string, email: string) =>
    prismaRoot.user.create({ data: { name, email, passwordHash: noLogin, isDemo: true, plan: "PRO", termsAcceptedAt: new Date() } })
  const admin = await mkUser("Ana Rojas (demo)", "admin@demo.stockly")
  const company = await prismaRoot.company.create({
    data: {
      name: "Ferretería El Tornillo", isDemo: true, ownerId: admin.id, currency: "CRC",
      legalName: "Ferretería El Tornillo S.A.", idType: "JURIDICA", idNumber: "3101999888", economicActivity: "475201",
      invoiceEmail: "facturas@eltornillo.demo", phone: "2222-3333", province: "1", canton: "01", district: "01",
      addressDetail: "Avenida Central, calle 5", returnDays: 365, sinpeNumber: "88887777", sinpeName: "Ferretería El Tornillo S.A.", onboardingDismissedAt: new Date(),
    },
  })
  const cid = company.id
  const centro = await prismaRoot.location.create({ data: { companyId: cid, name: "Sucursal Centro", type: "BRANCH", code: "001", address: "San José centro" } })
  const heredia = await prismaRoot.location.create({ data: { companyId: cid, name: "Sucursal Heredia", type: "BRANCH", code: "002", address: "Heredia, frente al parque" } })
  const bodega = await prismaRoot.location.create({ data: { companyId: cid, name: "Bodega Central", type: "WAREHOUSE", address: "Zona industrial, Pavas" } })
  const manager = await mkUser("Laura Jiménez (encargada)", "encargada@demo.stockly")
  const cashier = await mkUser("Carlos Mora (cajero)", "cajero@demo.stockly")
  const cashier2 = await mkUser("Diego Solís (cajero Heredia)", "cajero2@demo.stockly")
  const now = new Date()
  await prismaRoot.membership.createMany({
    data: [
      { userId: admin.id, companyId: cid, role: "ADMIN", pinHash: await hash("1593"), pinSetAt: now },
      { userId: manager.id, companyId: cid, role: "MANAGER", pinHash: await hash(DEMO_CODES.manager), pinSetAt: now },
      { userId: cashier.id, companyId: cid, role: "CASHIER", pinHash: await hash(DEMO_CODES.cashier), pinSetAt: now, locationIds: [centro.id] },
      { userId: cashier2.id, companyId: cid, role: "CASHIER", pinHash: await hash("8642"), pinSetAt: now, locationIds: [heredia.id] },
    ],
  })
  await prismaRoot.user.updateMany({ where: { id: { in: [admin.id, manager.id, cashier.id, cashier2.id] } }, data: { lastCompanyId: cid } })
  const A = actorOf(admin.id, "ADMIN")
  const M = actorOf(manager.id, "MANAGER")
  const C = actorOf(cashier.id, "CASHIER")
  const C2 = actorOf(cashier2.id, "CASHIER")

  await runWithCompany(cid, async () => {
    // ----- catálogo -----
    log("creando el catálogo y el stock…")
    const cats = new Map<string, string>()
    for (const name of CATEGORIES) cats.set(name, (await prisma.category.create({ data: { companyId: cid, name } })).id)
    const suppliers = []
    for (const s of SUPPLIERS) suppliers.push(await prisma.supplier.create({ data: { companyId: cid, ...s } }))
    const products: { id: string; p: P }[] = []
    for (const p of PRODUCTS) {
      const row = await prisma.product.create({
        data: {
          companyId: cid, sku: p.sku, name: p.name, unit: p.unit, price: p.price, cost: p.cost, taxRate: "RATE_13",
          cabys: CABYS[p.cat]!, minStock: p.min, stock: 0, categoryId: cats.get(p.cat)!,
          supplierId: suppliers[CATEGORIES.indexOf(p.cat) % suppliers.length]!.id,
        },
      })
      for (const [i, loc] of [centro, heredia, bodega].entries()) {
        if (p.stock[i]! > 0) await createMovement(row.id, admin.id, "IN", p.stock[i]!, "Stock inicial", undefined, { source: "INITIAL", locationId: loc.id })
      }
      products.push({ id: row.id, p })
    }
    const customers = []
    for (const c of CUSTOMERS) {
      const row = await prisma.customer.create({ data: { companyId: cid, name: c.name, idType: c.idType, idNumber: c.idNumber, email: `${c.idNumber}@clientes.demo` } })
      if (c.credit) await setCreditLimit(row.id, { creditLimit: c.credit }, admin.id)
      customers.push({ ...row, credit: c.credit })
    }
    const contractor = await prisma.discountType.create({ data: { companyId: cid, name: "Contratista", kind: "PERCENT", value: 10, appliesTo: "BOTH" } })
    await prisma.discountType.create({ data: { companyId: cid, name: "Descuento libre", kind: "PERCENT", value: null, maxPercent: 15, appliesTo: "BOTH" } })
    await prisma.discountType.create({ data: { companyId: cid, name: "Promo del mes", kind: "AMOUNT", value: 1000, appliesTo: "TOTAL" } })
    const regCentro = await prisma.cashRegister.create({ data: { companyId: cid, locationId: centro.id, name: "Caja 1", terminalCode: "00001" } })
    await prisma.cashRegister.create({ data: { companyId: cid, locationId: centro.id, name: "Caja 2", terminalCode: "00002" } })
    const regHeredia = await prisma.cashRegister.create({ data: { companyId: cid, locationId: heredia.id, name: "Caja 1", terminalCode: "00001" } })

    // ----- ventas día por día -----
    const weighted = products.flatMap((x) => Array(x.p.weight).fill(x) as typeof products)
    const qtyFor = (p: P) =>
      p.unit === "M" ? 2 + Math.floor(random() * 24) : p.unit === "KG" || p.unit === "L" ? round2(0.5 + Math.floor(random() * 6) * 0.5) : 1 + Math.floor(random() * (p.price < 3000 ? 6 : 2))
    const creditCustomers = customers.filter((c) => c.credit)
    const sold: { id: string; lineId: string; method: string; daysAgo: number }[] = []
    let refs = 0 // referencias de voucher/SINPE únicas (un comprobante SINPE no se repite)
    let negativeDone = false
    for (let daysAgo = days; daysAgo >= 1; daysAgo--) {
      const day = new Date(now.getTime() - daysAgo * DAY)
      if (day.getDay() === 0) continue // domingo cerrado
      for (const [register, who, base] of [[regCentro, C, 9], [regHeredia, C2, 5]] as const) {
        const pin = who === C ? DEMO_CODES.cashier : "8642"
        const session = await openSession({ registerId: register.id, pin, openingAmount: 50000 }, who)
        const sales = base + Math.floor(random() * 6)
        for (let n = 0; n < sales; n++) {
          const picked = [...new Map(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(weighted)).map((x) => [x.id, x])).values()]
          const withCustomer = random() < 0.2
          const customer = withCustomer ? pick(customers) : null
          const discountIdx = random() < 0.08 ? 0 : -1
          const lines = picked.map((x, i) => ({ productId: x.id, quantity: qtyFor(x.p), ...(i === discountIdx && { discount: { typeId: contractor.id } }) }))
          const total = round2(lines.reduce((s, l, i) => {
            const gross = picked[i]!.p.price * l.quantity
            return s + gross - ("discount" in l ? round2(gross * 0.1) : 0)
          }, 0))
          const r = random()
          const credit = customer?.credit && r < 0.15
          const method = r < 0.55 ? "CASH" : r < 0.85 ? "CARD" : "SINPE"
          const payments = credit
            ? []
            : [{ method, amount: total, ...(method === "CASH" && { tendered: Math.ceil(total / 1000) * 1000 }), ...(method !== "CASH" && { reference: String(100000 + refs++) }) }]
          try {
            const res = await sell({
              lines, payments: payments as never,
              ...(customer && { customerId: customer.id }),
              ...(discountIdx >= 0 && { discountPin: DEMO_CODES.manager }),
              ...(credit && { credit: { frequency: random() < 0.5 ? "MONTHLY" : "BIWEEKLY", installments: 2 + Math.floor(random() * 2) }, creditPin: DEMO_CODES.manager }),
            } as never, who)
            sold.push({ id: res.document.id, lineId: res.document.lines[0]!.id, method: credit ? "CREDIT" : method, daysAgo })
          } catch {
            // sin stock suficiente o el cliente pasó su límite: esa venta no se hace (como en la vida real)
          }
        }
        // una negativa autorizada en Heredia (un producto que ahí no hay)
        if (register === regHeredia && !negativeDone && daysAgo <= 10) {
          const shovel = products.find((x) => x.p.sku === "PLA-CUA")!
          await sell({ lines: [{ productId: shovel.id, quantity: 1 }], payments: [{ method: "CASH", amount: shovel.p.price, tendered: 10000 }], negativePin: DEMO_CODES.manager } as never, who).catch(() => {})
          negativeDone = true
        }
        // devoluciones de días anteriores (en buen estado casi siempre)
        if (register === regCentro && random() < 0.2) {
          const s = sold.find((x) => x.daysAgo > daysAgo && x.daysAgo - daysAgo <= 5 && x.method !== "CREDIT")
          if (s) {
            await createReturn(s.id, {
              lines: [{ lineId: s.lineId, quantity: 1, condition: random() < 0.25 ? "DAMAGED" : "GOOD" }],
              reason: pick(["No era la medida", "Venía dañado", "El cliente se arrepintió", "Producto equivocado"]),
              refund: { method: s.method === "CASH" ? "CASH" : (s.method as "CARD" | "SINPE"), ...(s.method !== "CASH" && { reference: "DEV" }) },
              pin: DEMO_CODES.manager,
            }, who).catch(() => {})
            sold.splice(sold.indexOf(s), 1)
          }
        }
        // abonos de clientes a crédito
        if (register === regCentro && random() < 0.3) {
          const c = pick(creditCustomers)
          const { balance } = await creditStatus(c.id)
          // José Rodríguez no paga: así la demo muestra una cuota vencida
          if (balance.greaterThan(0) && c.idNumber !== "205550222") {
            await registerPayment({ customerId: c.id, amount: Math.min(Number(balance), 20000 + Math.floor(random() * 4) * 10000), method: random() < 0.6 ? "CASH" : "SINPE", inRegister: true }, who).catch(() => {})
          }
        }
        // un depósito al banco de vez en cuando
        if (random() < 0.25) {
          const { expectedCash } = await sessionSummary(session.id)
          if (expectedCash > 150000) await addCashMovement({ type: "OUT", amount: 100000, reason: "Depósito al banco" }, who)
        }
        await closeSession(session.id, undefined, who)
        // la jefa de caja hace el arqueo; ayer en Heredia queda pendiente para que se vea
        if (!(register === regHeredia && daysAgo === 1)) {
          const { expectedCash, payments: paid } = await sessionSummary(session.id)
          const short = random() < 0.12 ? 500 * (1 + Math.floor(random() * 4)) : 0
          await reconcileSession(session.id, { denominations: countFor(expectedCash - short), cardDeclared: paid.CARD ?? 0 }, M)
        }
        await backdateSession(session.id, day, daysAgo)
      }
    }
    log(`ventas: ${sold.length}`)

    // ----- compras -----
    log("creando compras y solicitudes…")
    const lowOnes = products.filter((x) => x.p.cat === "Construcción").slice(0, 3)
    const po1 = await createPurchaseOrder(suppliers[3]!.id, admin.id, lowOnes.map((x) => ({ productId: x.id, quantity: 50, unitCost: x.p.cost })), undefined, bodega.id)
    await receivePurchaseOrder(po1.id, admin.id)
    const elect = products.filter((x) => x.p.cat === "Electricidad").slice(0, 3)
    const po2 = await createPurchaseOrder(suppliers[1]!.id, admin.id, elect.map((x) => ({ productId: x.id, quantity: x.p.unit === "M" ? 500 : 40, unitCost: x.p.cost })), undefined, centro.id)
    const full = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: po2.id }, include: { items: true } })
    await receivePurchaseOrder(po2.id, admin.id, [{ itemId: full.items[0]!.id, quantity: Number(full.items[0]!.quantity) / 2 }])
    const paint = products.filter((x) => x.p.cat === "Pinturas").slice(0, 2)
    await createPurchaseOrder(suppliers[2]!.id, admin.id, paint.map((x) => ({ productId: x.id, quantity: 12, unitCost: x.p.cost })), undefined, centro.id)
    for (const x of [products.find((y) => y.p.sku === "TAL-650")!, products.find((y) => y.p.sku === "MNG-15")!]) {
      await prisma.purchaseRequest.create({ data: { companyId: cid, productId: x.id, requestedById: cashier.id, quantity: 5, reason: "Los clientes lo están pidiendo" } })
    }
  })
  // el plazo de devolución vuelve al normal (estuvo abierto para generar devoluciones del pasado)
  await prismaRoot.company.update({ where: { id: cid }, data: { returnDays: 30 } })
  log("demo lista")
  return { companyId: cid }
}

// Entrar a la demo sin contraseña: el usuario demo de ese rol
export async function demoUser(role: "ADMIN" | "CASHIER") {
  const company = await prismaRoot.company.findFirst({ where: { isDemo: true }, select: { id: true } })
  if (!company) return null
  const m = await prismaRoot.membership.findFirst({
    where: { companyId: company.id, role, isActive: true, user: { isDemo: true, isActive: true }, ...(role === "CASHIER" && { user: { email: "cajero@demo.stockly", isDemo: true } }) },
    select: { userId: true },
  })
  return m && { userId: m.userId, companyId: company.id }
}

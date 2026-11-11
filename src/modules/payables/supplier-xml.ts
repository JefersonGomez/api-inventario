// Lee la factura electrónica de un proveedor (XML de Hacienda v4.4; también tolera la 4.3) y la respuesta
// de Hacienda que suele venir con ella. Solo lectura: no toca la base.
// Se busca por nombre local de los elementos, sin depender del espacio de nombres de cada versión.
import { DOMParser } from "@xmldom/xmldom"
import { Prisma } from "../../generated/prisma/client.ts"
import type { IdType, TaxRate } from "../../generated/prisma/enums.ts"

const D = Prisma.Decimal
type El = Element

const ID_TYPES: Record<string, IdType> = { "01": "FISICA", "02": "JURIDICA", "03": "DIMEX", "04": "NITE", "05": "EXTRANJERO" }
// tarifa del IVA por su porcentaje (las transitorias 0 % y 4 % caen en las de siempre)
const RATE_BY_PERCENT: Record<string, TaxRate> = { "0": "EXEMPT", "1": "RATE_1", "2": "RATE_2", "4": "RATE_4", "13": "RATE_13" }
// por código de tarifa (CodigoTarifaIVA / CodigoTarifa) cuando no viene el porcentaje
const RATE_BY_CODE: Record<string, TaxRate> = { "01": "EXEMPT", "02": "RATE_1", "03": "RATE_2", "04": "RATE_4", "05": "EXEMPT", "06": "RATE_4", "08": "RATE_13", "10": "EXEMPT", "11": "EXEMPT" }

const kids = (el: El | null | undefined, name: string): El[] =>
  el ? Array.from(el.childNodes).filter((n): n is El => n.nodeType === 1 && (n as El).localName === name) : []
const kid = (el: El | null | undefined, name: string) => kids(el, name)[0] ?? null
const txt = (el: El | null | undefined, ...path: string[]) => {
  let cur: El | null | undefined = el
  for (const p of path) cur = kid(cur, p)
  return cur?.textContent?.trim() || null
}
const num = (v: string | null) => new D(v && /^-?\d+(\.\d+)?$/.test(v) ? v : 0)

function parse(xml: string) {
  const errors: string[] = []
  const doc = new DOMParser({ onError: (level, msg) => { if (level !== "warning") errors.push(String(msg)) } }).parseFromString(xml, "text/xml")
  const root = doc.documentElement
  if (!root || errors.length) throw new Error("El archivo no es un XML válido")
  return root as unknown as El
}

export type ParsedLine = {
  line: number
  cabys: string | null
  code: string | null // código comercial del proveedor
  description: string
  quantity: number
  unit: string | null
  unitPrice: number
  discount: number
  subtotal: number // sin IVA, después del descuento
  rate: TaxRate
  tax: number // IVA neto (después de exoneraciones)
  total: number
}

export type ParsedSupplierInvoice = {
  kind: "INVOICE" | "TICKET"
  clave: string
  number: string // consecutivo de 20 dígitos
  issuedAt: Date
  supplier: { name: string; commercialName: string | null; idType: IdType | null; idNumber: string; email: string | null; phone: string | null }
  receiverId: string | null // identificación del receptor (debe ser la empresa)
  saleCondition: string | null // 01 contado, 02 crédito…
  creditDays: number | null
  currency: string
  exchangeRate: number
  lines: ParsedLine[]
  otherCharges: number // OtrosCargos (p. ej. servicio): no llevan IVA
  taxes: { rate: TaxRate; base: number; tax: number }[]
  total: number // TotalComprobante
  unsupportedRates: string[] // tarifas que el sistema no maneja (8 %, 0,5 %)
}

// La factura (o tiquete) del proveedor
export function parseSupplierInvoice(xml: string): ParsedSupplierInvoice {
  const root = parse(xml)
  const kind = root.localName === "FacturaElectronica" ? "INVOICE" : root.localName === "TiqueteElectronico" ? "TICKET" : null
  if (!kind) {
    if (root.localName === "NotaCreditoElectronica" || root.localName === "NotaDebitoElectronica") throw new Error("Es una nota de crédito o débito: todavía no se importan, regístrala a mano")
    if (root.localName === "MensajeHacienda") throw new Error("Ese archivo es la respuesta de Hacienda: sube también el XML de la factura")
    throw new Error("Ese XML no es una factura electrónica de Hacienda")
  }
  const clave = txt(root, "Clave")
  if (!clave || !/^\d{50}$/.test(clave)) throw new Error("La factura no trae una clave válida de 50 dígitos")
  const emisor = kid(root, "Emisor")
  const idNumber = (txt(emisor, "Identificacion", "Numero") ?? "").replace(/\D/g, "")
  if (!emisor || !idNumber) throw new Error("La factura no trae la identificación del proveedor")
  const issued = txt(root, "FechaEmision")
  const issuedAt = issued ? new Date(issued) : null
  if (!issuedAt || Number.isNaN(issuedAt.getTime())) throw new Error("La factura no trae una fecha de emisión válida")

  const resumen = kid(root, "ResumenFactura")
  const moneda = kid(resumen, "CodigoTipoMoneda")
  const currency = txt(moneda, "CodigoMoneda") ?? "CRC"
  const exchangeRate = num(txt(moneda, "TipoCambio") ?? "1").toNumber() || 1

  const unsupported = new Set<string>()
  const lines: ParsedLine[] = kids(kid(root, "DetalleServicio"), "LineaDetalle").map((l, i) => {
    const subtotal = num(txt(l, "SubTotal"))
    const discount = kids(l, "Descuento").reduce((s, d) => s.plus(num(txt(d, "MontoDescuento"))), new D(0))
    // IVA = Impuesto con Codigo 01 (o 07, IVA de cálculo especial); los demás impuestos no son IVA
    const iva = kids(l, "Impuesto").find((x) => ["01", "07"].includes(txt(x, "Codigo") ?? ""))
    let rate: TaxRate = "EXEMPT"
    if (iva) {
      const percent = txt(iva, "Tarifa")
      const code = txt(iva, "CodigoTarifaIVA") ?? txt(iva, "CodigoTarifa")
      const byPercent = percent ? RATE_BY_PERCENT[String(Number(percent))] : undefined
      const found = byPercent ?? (code ? RATE_BY_CODE[code] : undefined)
      if (found) rate = found
      else unsupported.add(percent ? `${Number(percent)} %` : `código ${code}`)
    }
    // IVA que realmente se pagó: ImpuestoNeto (descuenta exoneraciones); si no viene, el monto del IVA
    const net = txt(l, "ImpuestoNeto")
    const tax = net !== null ? num(net) : iva ? num(txt(iva, "Monto")).minus(num(txt(kid(iva, "Exoneracion"), "MontoExoneracion"))) : new D(0)
    const code = kids(l, "CodigoComercial").map((c) => txt(c, "Codigo")).find(Boolean) ?? null
    return {
      line: Number(txt(l, "NumeroLinea") ?? i + 1),
      cabys: txt(l, "CodigoCABYS") ?? txt(l, "Codigo"),
      code,
      description: txt(l, "Detalle") ?? "",
      quantity: num(txt(l, "Cantidad")).toNumber(),
      unit: txt(l, "UnidadMedida"),
      unitPrice: num(txt(l, "PrecioUnitario")).toNumber(),
      discount: discount.toNumber(),
      subtotal: subtotal.toNumber(),
      rate,
      tax: (tax.isNegative() ? new D(0) : tax).toNumber(),
      total: num(txt(l, "MontoTotalLinea")).toNumber(),
    }
  })
  if (!lines.length) throw new Error("La factura no trae líneas de detalle")

  const otherCharges = kids(root, "OtrosCargos").reduce((s, c) => s.plus(num(txt(c, "MontoCargo"))), new D(0))
  // IVA por tarifa, con lo que dicen las líneas; los otros cargos van como base sin IVA
  const byRate = new Map<TaxRate, { base: Prisma.Decimal; tax: Prisma.Decimal }>()
  const add = (rate: TaxRate, base: Prisma.Decimal | number, tax: Prisma.Decimal | number) => {
    const cur = byRate.get(rate) ?? { base: new D(0), tax: new D(0) }
    byRate.set(rate, { base: cur.base.plus(base), tax: cur.tax.plus(tax) })
  }
  for (const l of lines) add(l.rate, l.subtotal, l.tax)
  if (otherCharges.greaterThan(0)) add("EXEMPT", otherCharges, 0)

  const plazo = txt(root, "PlazoCredito")
  return {
    kind,
    clave,
    number: txt(root, "NumeroConsecutivo") ?? clave.slice(21, 41),
    issuedAt,
    supplier: {
      name: (txt(emisor, "Nombre") ?? "").replace(/\s+/g, " "),
      commercialName: txt(emisor, "NombreComercial"),
      idType: ID_TYPES[txt(emisor, "Identificacion", "Tipo") ?? ""] ?? null,
      idNumber,
      email: txt(emisor, "CorreoElectronico"),
      phone: txt(emisor, "Telefono", "NumTelefono"),
    },
    receiverId: (txt(kid(root, "Receptor"), "Identificacion", "Numero") ?? "").replace(/\D/g, "") || null,
    saleCondition: txt(root, "CondicionVenta"),
    creditDays: plazo && /^\d+$/.test(plazo) ? Number(plazo) : null,
    currency,
    exchangeRate,
    lines,
    otherCharges: otherCharges.toNumber(),
    taxes: [...byRate].map(([rate, v]) => ({ rate, base: v.base.toDecimalPlaces(2).toNumber(), tax: v.tax.toDecimalPlaces(2).toNumber() })),
    total: num(txt(resumen, "TotalComprobante")).toNumber(),
    unsupportedRates: [...unsupported],
  }
}

// Respuesta de Hacienda (MensajeHacienda): de qué clave es y qué dijo
export function parseHaciendaAnswer(xml: string) {
  const root = parse(xml)
  if (root.localName !== "MensajeHacienda") return null
  const code = txt(root, "Mensaje") // 1 aceptado, 2 aceptado parcial, 3 rechazado
  return {
    clave: txt(root, "Clave"),
    status: code === "3" ? "Rechazado" : code === "1" || code === "2" ? "Aceptado" : null,
    detail: txt(root, "DetalleMensaje"),
  }
}

// Qué es cada archivo subido (el orden da igual)
export function rootName(xml: string) {
  try {
    return parse(xml).localName
  } catch {
    return null
  }
}

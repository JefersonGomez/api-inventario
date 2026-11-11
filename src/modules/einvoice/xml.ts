// Arma el XML v4.4 de un comprobante (tiquete, factura y nota de crédito), sin firmar. El orden de los
// elementos es el del XSD oficial; los montos van con 5 decimales como guarda el sistema.
// Los precios de las líneas ya vienen SIN IVA (DocumentLine), así que solo se ordena y se suma.
import { Prisma } from "../../generated/prisma/client.ts"
import type { CurrencyCode, DocumentType, IdType, PaymentMethod, SaleCondition, TaxRate, UnitOfMeasure } from "../../generated/prisma/enums.ts"
import { DOCUMENT_CODE, TAX_PERCENT } from "../../shared/fiscal.ts"
import { crDateTime } from "./clave.ts"
import { DOCUMENT_XML, ID_TYPE_CODE, PAYMENT_CODE, RECEIVER_ID_TYPE_CODE, SALE_CONDITION_CODE, TAX_RATE_CODE, UNIT_CODE } from "./codes.ts"

const D = Prisma.Decimal
type Num = Prisma.Decimal | number | string

export type EInvoiceData = {
  type: DocumentType
  clave: string
  consecutive: string
  issuedAt: Date
  provider: string // ProveedorSistemas: cédula de quien provee el sistema
  activity: string // CodigoActividadEmisor (6 caracteres)
  emitter: {
    name: string
    commercialName?: string | null
    idType: IdType
    idNumber: string
    province: string
    canton: string
    district: string
    address: string
    phone?: string | null
    email: string
  }
  // cliente (obligatorio en la factura; el tiquete no lo lleva)
  receiver?: {
    name: string
    idType: IdType
    idNumber: string
    email?: string | null
  } | null
  // nota de crédito: el comprobante que corrige (obligatorio en la nota)
  reference?: {
    type: DocumentType // tipo del original (01 factura, 04 tiquete…)
    clave: string
    issuedAt: Date
    code: "01" | "06" // 01 anula el documento (se devuelve todo), 06 devolución de mercancía
    reason: string
  } | null
  currency: CurrencyCode
  exchangeRate?: Num // tipo de cambio (1 en colones)
  saleCondition: SaleCondition
  creditDays?: number | null
  lines: {
    cabys: string
    quantity: Num
    unit: UnitOfMeasure
    description: string
    unitPrice: Num // sin IVA
    discount: Num // monto sin IVA
    discountLabel?: string | null
    taxRate: TaxRate
    subtotal: Num // cantidad × precio − descuento
    taxAmount: Num
  }[]
  payments: { method: PaymentMethod; amount: Num }[]
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
const money = (v: Num) => new D(v).toDecimalPlaces(5).toFixed(5)
const qty = (v: Num) => new D(v).toDecimalPlaces(3).toFixed(3)
// texto recortado al largo que admite el XSD (y nunca vacío por debajo del mínimo)
const text = (s: string, max: number) => esc(s.trim().replace(/\s+/g, " ").slice(0, max))
const el = (name: string, value: string | null | undefined) => (value == null || value === "" ? "" : `<${name}>${value}</${name}>`)

export function buildEInvoiceXml(d: EInvoiceData) {
  const meta = DOCUMENT_XML[d.type]
  const idType = d.emitter.idType
  if (idType === "EXTRANJERO") throw new Error("El emisor necesita identificación costarricense")
  if (!d.lines.length) throw new Error("El comprobante no tiene líneas")
  const r = d.type === "TICKET" ? null : d.receiver
  if (d.type === "INVOICE" && !(r?.name.trim() && r.idNumber)) throw new Error("La factura necesita el nombre y la identificación del cliente")
  const receiverEmail = (r?.email ?? "").trim()
  const ref = d.reference
  if (d.type === "CREDIT_NOTE" && !ref?.clave) throw new Error("La nota de crédito necesita la clave del comprobante que corrige")

  // ---------- líneas ----------
  const totals = { taxed: new D(0), exempt: new D(0), discounts: new D(0), tax: new D(0) }
  const byRate = new Map<TaxRate, Prisma.Decimal>()
  const lines = d.lines.map((l, i) => {
    if (!/^\d{13}$/.test(l.cabys)) throw new Error(`Línea ${i + 1} (${l.description}): falta el código CABYS de 13 dígitos`)
    const quantity = new D(l.quantity)
    const gross = quantity.times(l.unitPrice).toDecimalPlaces(5) // MontoTotal = cantidad × precio unitario
    const discount = new D(l.discount)
    const subtotal = new D(l.subtotal)
    const tax = new D(l.taxAmount)
    if (l.taxRate === "EXEMPT") totals.exempt = totals.exempt.plus(gross)
    else totals.taxed = totals.taxed.plus(gross)
    totals.discounts = totals.discounts.plus(discount)
    totals.tax = totals.tax.plus(tax)
    byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? new D(0)).plus(tax))
    const label = (l.discountLabel ?? "").trim()
    return [
      "<LineaDetalle>",
      el("NumeroLinea", String(i + 1)),
      el("CodigoCABYS", l.cabys),
      el("Cantidad", qty(quantity)),
      el("UnidadMedida", UNIT_CODE[l.unit]),
      el("Detalle", text(l.description.padEnd(3, "."), 200)),
      el("PrecioUnitario", money(l.unitPrice)),
      el("MontoTotal", money(gross)),
      discount.greaterThan(0)
        ? `<Descuento>${el("MontoDescuento", money(discount))}${el("CodigoDescuento", "07")}${label.length >= 3 ? el("NaturalezaDescuento", text(label, 80)) : ""}</Descuento>`
        : "",
      el("SubTotal", money(subtotal)),
      el("BaseImponible", money(subtotal)),
      "<Impuesto>",
      el("Codigo", "01"),
      el("CodigoTarifaIVA", TAX_RATE_CODE[l.taxRate]),
      el("Tarifa", new D(TAX_PERCENT[l.taxRate]).toFixed(2)),
      el("Monto", money(tax)),
      "</Impuesto>",
      el("ImpuestoAsumidoEmisorFabrica", money(0)),
      el("ImpuestoNeto", money(tax)),
      el("MontoTotalLinea", money(subtotal.plus(tax))),
      "</LineaDetalle>",
    ].join("")
  })

  // ---------- resumen ----------
  const sale = totals.taxed.plus(totals.exempt)
  const net = sale.minus(totals.discounts)
  const total = net.plus(totals.tax)
  // medios de pago: uno por método (máximo 4); en contado con un solo medio, el total exacto
  const paid = new Map<PaymentMethod, Prisma.Decimal>()
  for (const p of d.payments) paid.set(p.method, (paid.get(p.method) ?? new D(0)).plus(p.amount))
  if (paid.size > 4) throw new Error("Hacienda admite hasta 4 medios de pago por comprobante")
  if (d.saleCondition === "CASH" && paid.size === 1) paid.set([...paid.keys()][0]!, total)
  const breakdown = [...byRate]
    .filter(([rate]) => rate !== "EXEMPT")
    .map(([rate, amount]) => `<TotalDesgloseImpuesto>${el("Codigo", "01")}${el("CodigoTarifaIVA", TAX_RATE_CODE[rate])}${el("TotalMontoImpuesto", money(amount))}</TotalDesgloseImpuesto>`)

  const e = d.emitter
  const phone = (e.phone ?? "").replace(/\D/g, "")
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<${meta.root} xmlns="${meta.ns}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    el("Clave", d.clave),
    el("ProveedorSistemas", esc(d.provider)),
    el("CodigoActividadEmisor", esc(d.activity)),
    el("NumeroConsecutivo", d.consecutive),
    el("FechaEmision", crDateTime(d.issuedAt)),
    "<Emisor>",
    el("Nombre", text(e.name, 100)),
    `<Identificacion>${el("Tipo", ID_TYPE_CODE[idType])}${el("Numero", e.idNumber)}</Identificacion>`,
    e.commercialName && e.commercialName.trim().length >= 3 ? el("NombreComercial", text(e.commercialName, 80)) : "",
    `<Ubicacion>${el("Provincia", e.province)}${el("Canton", e.canton.padStart(2, "0"))}${el("Distrito", e.district.padStart(2, "0"))}${el("OtrasSenas", text(e.address, 250))}</Ubicacion>`,
    phone.length >= 8 ? `<Telefono>${el("CodigoPais", "506")}${el("NumTelefono", phone.slice(-8))}</Telefono>` : "",
    el("CorreoElectronico", esc(e.email.trim())),
    "</Emisor>",
    r
      ? [
          "<Receptor>",
          el("Nombre", text(r.name, 100)),
          `<Identificacion>${el("Tipo", RECEIVER_ID_TYPE_CODE[r.idType])}${el("Numero", esc(r.idNumber.replace(/[\s-]/g, "").slice(0, 20)))}</Identificacion>`,
          /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(receiverEmail) ? el("CorreoElectronico", esc(receiverEmail.slice(0, 160))) : "",
          "</Receptor>",
        ].join("")
      : "",
    el("CondicionVenta", SALE_CONDITION_CODE[d.saleCondition]),
    d.saleCondition === "CREDIT" ? el("PlazoCredito", String(Math.max(d.creditDays ?? 0, 1))) : "",
    `<DetalleServicio>${lines.join("")}</DetalleServicio>`,
    "<ResumenFactura>",
    `<CodigoTipoMoneda>${el("CodigoMoneda", d.currency)}${el("TipoCambio", money(d.exchangeRate ?? 1))}</CodigoTipoMoneda>`,
    el("TotalMercanciasGravadas", money(totals.taxed)),
    el("TotalMercanciasExentas", money(totals.exempt)),
    el("TotalGravado", money(totals.taxed)),
    el("TotalExento", money(totals.exempt)),
    el("TotalVenta", money(sale)),
    el("TotalDescuentos", money(totals.discounts)),
    el("TotalVentaNeta", money(net)),
    breakdown.join(""),
    el("TotalImpuesto", money(totals.tax)),
    [...paid]
      .map(([m, amount]) => `<MedioPago>${el("TipoMedioPago", PAYMENT_CODE[m])}${m === "OTHER" ? el("MedioPagoOtros", "Otro medio de pago") : ""}${el("TotalMedioPago", money(amount))}</MedioPago>`)
      .join(""),
    el("TotalComprobante", money(total)),
    "</ResumenFactura>",
    ref
      ? [
          "<InformacionReferencia>",
          el("TipoDocIR", DOCUMENT_CODE[ref.type as keyof typeof DOCUMENT_CODE]),
          el("Numero", ref.clave),
          el("FechaEmisionIR", crDateTime(ref.issuedAt)),
          el("Codigo", ref.code),
          el("Razon", text(ref.reason || "Devolución", 180)),
          "</InformacionReferencia>",
        ].join("")
      : "",
    `</${meta.root}>`,
  ].join("")
}

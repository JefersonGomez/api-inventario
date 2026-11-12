// Arma el XML del mensaje receptor v4.4 (MensajeReceptor), sin firmar, en el orden del XSD oficial.
import { Prisma } from "../../generated/prisma/client.ts"
import { crDateTime } from "./clave.ts"

const D = Prisma.Decimal
type Num = Prisma.Decimal | number | string
const NS = "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/mensajeReceptor"
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
const money = (v: Num) => new D(v).toDecimalPlaces(5).toFixed(5)
const el = (name: string, value: string | null | undefined) => (value == null || value === "" ? "" : `<${name}>${value}</${name}>`)

// tipo del consecutivo del mensaje: 05 aceptación, 06 aceptación parcial, 07 rechazo
export const RECEIVER_TYPE = { "1": "05", "2": "06", "3": "07" } as const
export type Decision = keyof typeof RECEIVER_TYPE

export type ReceiverMessageData = {
  clave: string // la de la factura del proveedor
  supplierId: string // NumeroCedulaEmisor (el proveedor)
  issuedAt: Date // fecha del mensaje
  decision: Decision
  detail?: string | null
  tax: Num // MontoTotalImpuesto de la factura
  activity?: string | null // CodigoActividad de la empresa
  condition?: "01" | "04" | null // 01 crédito de IVA, 04 gasto que no genera crédito
  taxCredit?: Num | null // MontoTotalImpuestoAcreditar
  expense?: Num | null // MontoTotalDeGastoAplicable
  total: Num // TotalFactura
  receiverId: string // NumeroCedulaReceptor (la empresa)
  consecutive: string // NumeroConsecutivoReceptor
}

export function buildReceiverMessageXml(d: ReceiverMessageData) {
  if (!/^\d{50}$/.test(d.clave)) throw new Error("La clave de la factura no es válida")
  if (!/^\d{20}$/.test(d.consecutive)) throw new Error("El consecutivo del mensaje debe tener 20 dígitos")
  const receiverId = d.receiverId.replace(/\D/g, "")
  if (!/^\d{9,12}$/.test(receiverId)) throw new Error("La empresa necesita su cédula en Datos fiscales para responder a Hacienda")
  const accepted = d.decision !== "3"
  const activity = (d.activity ?? "").trim()
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<MensajeReceptor xmlns="${NS}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    el("Clave", d.clave),
    el("NumeroCedulaEmisor", esc(d.supplierId.replace(/[\s-]/g, "").slice(0, 20))),
    el("FechaEmisionDoc", crDateTime(d.issuedAt)),
    el("Mensaje", d.decision),
    el("DetalleMensaje", d.detail?.trim() ? esc(d.detail.trim().replace(/\s+/g, " ").slice(0, 160)) : null),
    el("MontoTotalImpuesto", money(d.tax)),
    activity.length === 6 ? el("CodigoActividad", esc(activity)) : "",
    // la condición del IVA y los montos solo tienen sentido si se acepta
    accepted && d.condition ? el("CondicionImpuesto", d.condition) : "",
    accepted && d.condition ? el("MontoTotalImpuestoAcreditar", money(d.taxCredit ?? 0)) : "",
    accepted && d.condition ? el("MontoTotalDeGastoAplicable", money(d.expense ?? 0)) : "",
    el("TotalFactura", money(d.total)),
    el("NumeroCedulaReceptor", receiverId),
    el("NumeroConsecutivoReceptor", d.consecutive),
    `</MensajeReceptor>`,
  ].join("")
}

// Piezas de prueba para la facturación electrónica: llaves .p12 autofirmadas y facturas de proveedor de ejemplo.
import forge from "node-forge"
import { buildClave } from "../modules/einvoice/clave.ts"
import type { EInvoiceData } from "../modules/einvoice/xml.ts"

export const SUPPLIER_ID = "3101555444" // cédula jurídica del proveedor de prueba
export const COMPANY_ID = "3101999888" // cédula jurídica de la empresa que recibe

// Llave .p12 de prueba con la cédula en el serialNumber, como las de Hacienda (CPJ-… jurídica, CPF-… física)
export function makeP12(pin: string, serialNumber: string, commonName = "TITULAR DE PRUEBA") {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = "01"
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const subject = [{ name: "commonName", value: commonName }, { name: "serialNumber", value: serialNumber }]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: "3des" })).getBytes(), "binary")
}

let seq = 0
// Factura del proveedor a nombre de la empresa: 2 martillos (13 %) + 1 kg de arroz (1 %), a 30 días.
// Total 7564: base 5800 + IVA 754 y base 1000 + IVA 10.
export function supplierInvoice(over: Partial<EInvoiceData> = {}): EInvoiceData {
  const issuedAt = new Date("2026-11-10T16:00:00Z") // 10:00 en Costa Rica
  const consecutive = `0010000101${String(++seq).padStart(10, "0")}`
  return {
    type: "INVOICE", consecutive, issuedAt,
    clave: buildClave({ issuedAt, idNumber: SUPPLIER_ID, consecutive }),
    provider: SUPPLIER_ID, activity: "4659.0",
    emitter: { name: "Distribuidora de Prueba S.A.", idType: "JURIDICA", idNumber: SUPPLIER_ID, province: "1", canton: "01", district: "01", address: "San José centro", email: "ventas@distribuidora.cr", phone: "2222-1111" },
    receiver: { name: "Ferretería El Tornillo S.A.", idType: "JURIDICA", idNumber: COMPANY_ID, email: "facturas@eltornillo.cr" },
    currency: "CRC", saleCondition: "CREDIT", creditDays: 30,
    lines: [
      { cabys: "4292199990200", quantity: 2, unit: "UNIT", description: "Martillo de uña 16 oz", unitPrice: "3000", discount: "200", discountLabel: "Promoción", taxRate: "RATE_13", subtotal: "5800", taxAmount: "754" },
      { cabys: "2314000991000", quantity: 1, unit: "KG", description: "Arroz precocido", unitPrice: "1000", discount: 0, taxRate: "RATE_1", subtotal: "1000", taxAmount: "10" },
    ],
    payments: [],
    ...over,
  }
}

// Respuesta de Hacienda a una factura (MensajeHacienda): 1 aceptada, 3 rechazada
export const answerXml = (clave: string, mensaje: "1" | "3") =>
  `<?xml version="1.0" encoding="utf-8"?><MensajeHacienda xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/mensajeHacienda"><Clave>${clave}</Clave><NombreEmisor>Distribuidora</NombreEmisor><Mensaje>${mensaje}</Mensaje><DetalleMensaje>${mensaje === "1" ? "Aceptado" : "Rechazado"}</DetalleMensaje></MensajeHacienda>`

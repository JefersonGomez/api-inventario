// Códigos de Hacienda (Anexos y Estructuras v4.4) para los valores que guarda el sistema.
// Verificados contra el XSD oficial TiqueteElectronico_V4.4 (revisión 2026).
import type { DocumentType, IdType, PaymentMethod, SaleCondition, TaxRate, UnitOfMeasure } from "../../generated/prisma/enums.ts"

// Tipo de identificación (IdentificacionType/Tipo); el extranjero no se identifica así en el emisor
export const ID_TYPE_CODE: Record<Exclude<IdType, "EXTRANJERO">, string> = { FISICA: "01", JURIDICA: "02", DIMEX: "03", NITE: "04" }
// Receptor (cliente): el extranjero va como 05 "extranjero no domiciliado"
export const RECEIVER_ID_TYPE_CODE: Record<IdType, string> = { ...ID_TYPE_CODE, EXTRANJERO: "05" }

// Código de tarifa del IVA (CodigoTarifaIVAType) y su porcentaje
export const TAX_RATE_CODE: Record<TaxRate, string> = { RATE_1: "02", RATE_2: "03", RATE_4: "04", RATE_13: "08", EXEMPT: "10" }

// Unidad de medida (UnidadMedidaType, RTC 443:2010): en 4.4 kilogramo es "Kg", gramo "G" y metro "M"
export const UNIT_CODE: Record<UnitOfMeasure, string> = { UNIT: "Unid", KG: "Kg", G: "G", L: "L", ML: "mL", M: "M", CM: "cm", M2: "m²" }

// Medio de pago (TipoMedioPago): 01 efectivo, 02 tarjeta, 04 transferencia, 06 SINPE Móvil, 99 otros
export const PAYMENT_CODE: Record<PaymentMethod, string> = { CASH: "01", CARD: "02", TRANSFER: "04", SINPE: "06", OTHER: "99" }

// Condición de venta: 01 contado, 02 crédito
export const SALE_CONDITION_CODE: Record<SaleCondition, string> = { CASH: "01", CREDIT: "02" }

// Raíz y espacio de nombres de cada comprobante
export const DOCUMENT_XML: Record<DocumentType, { root: string; ns: string }> = {
  TICKET: { root: "TiqueteElectronico", ns: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico" },
  INVOICE: { root: "FacturaElectronica", ns: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica" },
  CREDIT_NOTE: { root: "NotaCreditoElectronica", ns: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica" },
  DEBIT_NOTE: { root: "NotaDebitoElectronica", ns: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica" },
}

// Política de firma XAdES-EPES (Anexo 2): identificador y SHA-256 del PDF de la resolución
export const XADES_POLICY = {
  uri: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/Resoluci%C3%B3n_General_sobre_disposiciones_t%C3%A9cnicas_comprobantes_electr%C3%B3nicos_para_efectos_tributarios.pdf",
  digest: "DWxin1xWOeI8OuWQXazh4VjLWAaCLAA954em7DMh0h8=",
}

// Servicios de Hacienda por ambiente
export const HACIENDA_ENDPOINTS = {
  pruebas: {
    token: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut-stag/protocol/openid-connect/token",
    clientId: "api-stag",
    api: "https://api-sandbox.comprobanteselectronicos.go.cr/recepcion/v1",
  },
  produccion: {
    token: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token",
    clientId: "api-prod",
    api: "https://api.comprobanteselectronicos.go.cr/recepcion/v1",
  },
} as const
export type HaciendaEnv = keyof typeof HACIENDA_ENDPOINTS

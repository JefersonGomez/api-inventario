// Valida un comprobante contra el XSD oficial v4.4 (copiado en ./xsd, revisión 2026 de Hacienda).
// Se usa en las pruebas y antes de enviar: un error de esquema se ve aquí y no como rechazo de Hacienda.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { validateXML } from "xmllint-wasm"
import type { DocumentType } from "../../generated/prisma/enums.ts"

const dir = fileURLToPath(new URL("./xsd/", import.meta.url))
const SCHEMAS: Partial<Record<DocumentType, string>> = { TICKET: "TiqueteElectronico_V4.4.xsd", INVOICE: "FacturaElectronica_V4.4.xsd", CREDIT_NOTE: "NotaCreditoElectronica_V4.4.xsd" }
export const RECEIVER_MESSAGE_XSD = "MensajeReceptor_V4.4.xsd"
const cache = new Map<string, string>()
const read = (name: string) => {
  if (!cache.has(name)) cache.set(name, readFileSync(dir + name, "utf8"))
  return cache.get(name)!
}

// Lista de errores (vacía = válido) contra un XSD de ./xsd
export async function validateWithSchema(schema: string, xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: "comprobante.xml", contents: xml }],
    schema: [{ fileName: schema, contents: read(schema) }],
    preload: [{ fileName: "xmldsig-core-schema.xsd", contents: read("xmldsig-core-schema.xsd") }],
  })
  return result.valid ? [] : result.errors.map((e) => e.message.replace(/^comprobante\.xml:\d+: /, ""))
}

// Un comprobante propio por su tipo. Sin esquema para el tipo, no se valida.
export async function validateEInvoiceXml(type: DocumentType, xml: string): Promise<string[]> {
  const schema = SCHEMAS[type]
  return schema ? validateWithSchema(schema, xml) : []
}

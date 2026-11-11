// Prueba de punta a punta con el AMBIENTE DE PRUEBAS de Hacienda (Bloque 9, fase 1), sin tocar la base:
// arma un tiquete de ejemplo a nombre del titular de la llave, lo valida contra el XSD, lo firma, lo envía
// y consulta la respuesta hasta que Hacienda lo acepte o lo rechace.
// Uso: npm run einvoice:sandbox  (lee HACIENDA_* del .env; se niega a correr con HACIENDA_ENV=produccion)
// Nunca imprime la clave, el PIN ni el token.
import "dotenv/config"
import { readFileSync } from "node:fs"
import { buildClave, crDateTime } from "../src/modules/einvoice/clave.ts"
import { haciendaStatus, sendToHacienda } from "../src/modules/einvoice/hacienda.client.ts"
import { loadSigningKey, signXml } from "../src/modules/einvoice/signer.ts"
import { buildEInvoiceXml } from "../src/modules/einvoice/xml.ts"
import { validateEInvoiceXml } from "../src/modules/einvoice/xsd-validate.ts"

const env = process.env
if (env.HACIENDA_ENV !== "pruebas") throw new Error("Este script solo corre con HACIENDA_ENV=pruebas")
const creds = { env: "pruebas" as const, username: env.HACIENDA_USER!, password: env.HACIENDA_PASSWORD! }
const key = await loadSigningKey(readFileSync(env.HACIENDA_P12_PATH!), env.HACIENDA_P12_PIN!)
const id = key.holderId
const idType = id.length === 9 ? "FISICA" : "JURIDICA"

// actividad económica inscrita del titular (API pública de Hacienda); si no se puede, la del .env
let activity = env.HACIENDA_ACTIVITY ?? ""
if (!activity) {
  const r = await fetch(`https://api.hacienda.go.cr/fe/ae?identificacion=${id}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
  const body = r?.ok ? ((await r.json()) as { actividades?: { codigo: string; estado: string; descripcion: string }[] }) : null
  const active = body?.actividades?.find((a) => a.estado === "A") ?? body?.actividades?.[0]
  activity = active?.codigo ?? ""
  console.log(active ? `Actividad: ${active.codigo} (${active.descripcion})` : "No se encontró la actividad en la API pública")
}
if (!activity) throw new Error("Falta la actividad económica: ponla en HACIENDA_ACTIVITY en el .env")
// con TRIBU-CR el código va tal cual, con su punto: "6201.0" (6 caracteres)
activity = activity.trim()

// la ubicación debe ser la registrada en Hacienda: HACIENDA_TEST_UBICACION=provincia-cantón-distrito (ej. 1-01-01)
const [province, canton, district] = (env.HACIENDA_TEST_UBICACION || "1-01-01").split("-") as [string, string, string]

const issuedAt = new Date()
// consecutivo de prueba: sucursal 001, terminal 99999, tiquete (04), número = segundos del día (no choca)
const consecutive = `0019999904${String(Math.floor(issuedAt.getTime() / 1000) % 10_000_000_000).padStart(10, "0")}`
const clave = buildClave({ issuedAt, idNumber: id, consecutive })
const xml = buildEInvoiceXml({
  type: "TICKET", clave, consecutive, issuedAt, provider: id, activity,
  emitter: {
    name: key.holderName || "Emisor de prueba", idType, idNumber: id,
    province, canton, district, address: "Prueba del sistema de inventario", email: "pruebas@example.com",
  },
  currency: "CRC", saleCondition: "CASH",
  lines: [{ cabys: env.HACIENDA_TEST_CABYS || "4292199990200", quantity: 1, unit: "UNIT", description: "Martillo de prueba", unitPrice: "1000", discount: 0, taxRate: "RATE_13", subtotal: "1000", taxAmount: "130" }],
  payments: [{ method: "CASH", amount: 1130 }],
})
const errors = await validateEInvoiceXml("TICKET", xml.replace(`</TiqueteElectronico>`, `<ds:Signature/></TiqueteElectronico>`))
if (errors.some((e) => !e.includes("Signature"))) throw new Error(`El XML no cumple el esquema:\n${errors.join("\n")}`)
const signed = await signXml(xml, key, issuedAt)
const schemaErrors = await validateEInvoiceXml("TICKET", signed)
if (schemaErrors.length) throw new Error(`El XML firmado no cumple el esquema:\n${schemaErrors.join("\n")}`)
console.log(`Clave: ${clave}`)

const sent = await sendToHacienda(creds, {
  clave, fecha: crDateTime(issuedAt),
  emisor: { tipoIdentificacion: idType === "FISICA" ? "01" : "02", numeroIdentificacion: id },
  comprobanteXml: Buffer.from(signed, "utf8").toString("base64"),
})
console.log(sent.received ? `Enviado ✔ (HTTP ${sent.status})` : `Envío rechazado ✘ (HTTP ${sent.status}): ${sent.error}`)
if (!sent.received) process.exit(1)

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const st = await haciendaStatus(creds, clave)
  console.log(`Estado: ${st?.state ?? "todavía no aparece"}`)
  if (st && ["aceptado", "rechazado", "error"].includes(st.state)) {
    if (st.message) console.log(`Mensaje de Hacienda: ${st.message}`)
    process.exit(st.state === "aceptado" ? 0 : 1)
  }
}
console.log("Hacienda sigue procesando; vuelve a consultar más tarde con la clave de arriba.")

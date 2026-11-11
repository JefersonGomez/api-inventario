// Configuración de facturación electrónica de la empresa (Bloque 9, fase 2). La carga quien tiene
// company.manage: ambiente, usuario y clave de Hacienda, la llave .p12 con su PIN y el interruptor del
// envío automático. Lo secreto se cifra (secret-box) y nunca vuelve por la API: solo "hay clave" y los
// datos públicos del certificado (titular y vencimiento).
import { z } from "zod"
import { prisma } from "../../config/database.ts"
import { open, seal } from "../../shared/secret-box.ts"
import { logAudit } from "../audit/audit.service.ts"
import { getCompany } from "../company/company.service.ts"
import type { HaciendaEnv } from "./codes.ts"
import { notConfigured } from "./einvoice.config.ts"
import { assertFiscalData } from "./einvoice.service.ts"
import { checkCredentials } from "./hacienda.client.ts"
import { loadSigningKey, type SigningKey } from "./signer.ts"

const fail = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code && { code }) })
const sameId = (a: string, b: string) => a.replace(/\D/g, "").replace(/^0+/, "") === b.replace(/\D/g, "").replace(/^0+/, "")

// llega como multipart (por la llave): los valores son texto
export const settingsSchema = z.object({
  environment: z.enum(["pruebas", "produccion"]).optional(),
  username: z.string().trim().max(120).optional(),
  password: z.string().max(200).optional(), // vacío = no se cambia
  pin: z.string().max(60).optional(),
  provider: z.string().trim().max(20).optional(),
  enabled: z.enum(["true", "false"]).optional(),
})

type Settings = NonNullable<Awaited<ReturnType<typeof prisma.eInvoiceSettings.findFirst>>>

const view = (s: Settings | null) => ({
  configured: Boolean(s?.username && s.passwordEnc && s.p12Enc && s.pinEnc),
  enabled: s?.enabled ?? false,
  enabledAt: s?.enabledAt ?? null,
  environment: (s?.environment ?? "pruebas") as HaciendaEnv,
  username: s?.username ?? "",
  hasPassword: Boolean(s?.passwordEnc),
  key: s?.holderId ? { holderId: s.holderId, holderName: s.holderName, expiresAt: s.keyExpiresAt } : null,
  provider: s?.provider ?? "",
  updatedAt: s?.updatedAt ?? null,
  secretReady: (process.env.EINVOICE_SECRET ?? "").length >= 32, // el servidor puede guardar secretos
})

export async function getSettings() {
  return view(await prisma.eInvoiceSettings.findFirst())
}

export async function saveSettings(input: z.infer<typeof settingsSchema>, p12: Buffer | undefined, actorId: string) {
  const company = await getCompany()
  if (!company.idType || !company.idNumber) {
    throw fail("Primero completa la identificación de la empresa (Configuración → Datos fiscales)", 409, "EINVOICE_FISCAL_DATA")
  }
  const current = await prisma.eInvoiceSettings.findFirst()
  const data: Record<string, unknown> = {}
  const changed: string[] = []

  // llave nueva (con su PIN) o solo PIN nuevo para la llave guardada
  let key: SigningKey | null = null
  if (p12) {
    if (!input.pin) throw fail("Escribe el PIN de la llave criptográfica", 400, "EINVOICE_PIN")
    key = await loadSigningKey(p12, input.pin).catch((e: Error) => { throw fail(e.message, 400, "EINVOICE_PIN") })
    Object.assign(data, { p12Enc: seal(p12), pinEnc: seal(input.pin) })
    changed.push("llave")
  } else if (input.pin) {
    if (!current?.p12Enc) throw fail("Sube primero la llave criptográfica (.p12)", 400, "EINVOICE_KEY")
    key = await loadSigningKey(open(current.p12Enc), input.pin).catch((e: Error) => { throw fail(e.message, 400, "EINVOICE_PIN") })
    data.pinEnc = seal(input.pin)
    changed.push("PIN")
  }
  if (key) {
    if (!sameId(key.holderId, company.idNumber)) {
      throw fail(`La llave es de la identificación ${key.holderId} y la empresa es ${company.idNumber}: no corresponde`, 409, "EINVOICE_KEY_MISMATCH")
    }
    if (key.notAfter < new Date()) throw fail("La llave criptográfica está vencida: descarga una nueva en Hacienda", 409, "EINVOICE_KEY_EXPIRED")
    Object.assign(data, { holderId: key.holderId, holderName: key.holderName, keyExpiresAt: key.notAfter })
  }
  if (input.username !== undefined && input.username !== (current?.username ?? "")) {
    data.username = input.username || null
    changed.push("usuario")
  }
  if (input.password) {
    data.passwordEnc = seal(input.password)
    changed.push("clave")
  }
  if (input.environment && input.environment !== (current?.environment ?? "pruebas")) {
    data.environment = input.environment
    changed.push(`ambiente ${input.environment}`)
  }
  if (input.provider !== undefined) data.provider = input.provider.replace(/\D/g, "") || null

  // cómo queda todo junto (lo nuevo sobre lo guardado)
  const merged = {
    username: (data.username as string | null | undefined) ?? current?.username ?? null,
    password: input.password || (current?.passwordEnc ? open(current.passwordEnc).toString("utf8") : null),
    hasKey: Boolean(data.p12Enc ?? current?.p12Enc),
    environment: ((data.environment as string | undefined) ?? current?.environment ?? "pruebas") as HaciendaEnv,
  }
  const enabling = input.enabled === "true"
  if (input.enabled === "false" && current?.enabled) {
    Object.assign(data, { enabled: false, enabledAt: null })
    changed.push("envío automático apagado")
  }
  if (enabling) {
    if (!merged.username || !merged.password || !merged.hasKey) throw notConfigured()
    assertFiscalData(company)
    if (!current?.enabled) {
      Object.assign(data, { enabled: true, enabledAt: new Date() })
      changed.push("envío automático encendido")
    }
  }
  // usuario y clave se prueban contra Hacienda antes de guardarlos (o al encender el envío)
  const credsChanged = changed.some((c) => c === "usuario" || c === "clave" || c.startsWith("ambiente"))
  if ((credsChanged || (enabling && !current?.enabled)) && merged.username && merged.password) {
    await checkCredentials({ env: merged.environment, username: merged.username, password: merged.password })
      .catch((e: Error) => { throw fail(e.message, 409, "EINVOICE_CREDENTIALS") })
  }

  const saved = current
    ? await prisma.eInvoiceSettings.update({ where: { id: current.id }, data: { ...data, updatedById: actorId } })
    : await prisma.eInvoiceSettings.create({ data: { ...data, companyId: company.id, updatedById: actorId } })
  // en la auditoría solo QUÉ cambió, nunca los valores
  if (changed.length) await logAudit(actorId, current ? "UPDATE" : "CREATE", "EInvoiceSettings", saved.id, { changed })
  return view(saved)
}

// "Probar conexión": usuario y clave guardados contra Hacienda
export async function testSettings() {
  const s = await prisma.eInvoiceSettings.findFirst()
  if (!s?.username || !s.passwordEnc) throw notConfigured()
  await checkCredentials({ env: s.environment as HaciendaEnv, username: s.username, password: open(s.passwordEnc).toString("utf8") })
    .catch((e: Error) => { throw fail(e.message, 409, "EINVOICE_CREDENTIALS") })
  return { ok: true, environment: s.environment }
}

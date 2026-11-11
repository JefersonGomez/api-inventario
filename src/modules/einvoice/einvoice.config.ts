// Credenciales de Hacienda de la empresa actual (fase 2): salen de EInvoiceSettings, cifradas en la base.
// La llave se descifra y se carga una vez por versión de la configuración y queda en memoria; nunca se
// registra ni se devuelve. (El .env HACIENDA_* ya solo lo usa `npm run einvoice:sandbox`.)
import { prisma } from "../../config/database.ts"
import { currentCompanyId } from "../../shared/tenant.ts"
import { open, openText } from "../../shared/secret-box.ts"
import type { HaciendaEnv } from "./codes.ts"
import type { HaciendaCredentials } from "./hacienda.client.ts"
import { loadSigningKey, type SigningKey } from "./signer.ts"

export type EInvoiceConfig = {
  credentials: HaciendaCredentials
  key: SigningKey
  provider: string
  enabled: boolean
  enabledAt: Date | null
}

const cache = new Map<string, { stamp: number; config: EInvoiceConfig }>()

export const notConfigured = () =>
  Object.assign(new Error("La facturación electrónica no está configurada (Configuración → Facturación electrónica)"), { status: 409, code: "EINVOICE_NOT_CONFIGURED" })

export async function einvoiceConfig(): Promise<EInvoiceConfig> {
  const s = await prisma.eInvoiceSettings.findFirst()
  if (!s?.username || !s.passwordEnc || !s.p12Enc || !s.pinEnc) throw notConfigured()
  const companyId = currentCompanyId()
  const hit = cache.get(companyId)
  if (hit && hit.stamp === s.updatedAt.getTime()) return hit.config
  const key = await loadSigningKey(open(s.p12Enc), openText(s.pinEnc))
  const config: EInvoiceConfig = {
    credentials: { env: s.environment as HaciendaEnv, username: s.username, password: openText(s.passwordEnc) },
    key,
    provider: (s.provider || key.holderId).replace(/\D/g, ""), // cédula de quien provee el sistema
    enabled: s.enabled,
    enabledAt: s.enabledAt,
  }
  cache.set(companyId, { stamp: s.updatedAt.getTime(), config })
  return config
}

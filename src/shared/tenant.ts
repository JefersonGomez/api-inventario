// Empresa activa de la petición en curso. La fija el middleware Authenticated y la lee
// el cliente de Prisma (config/database.ts) para filtrar todo por empresa.
// También lleva las ubicaciones (Bloque 4): en cuáles trabaja la persona y en cuál está ahora.
import { AsyncLocalStorage } from "node:async_hooks";

// allowed: ubicaciones donde trabaja (null = todas); active: la que eligió en el selector (null = todas las suyas)
export type LocationScope = { allowed: string[] | null; active: string | null };

const storage = new AsyncLocalStorage<{ companyId: string; locations: LocationScope }>();

export function runWithCompany<T>(companyId: string, fn: () => T, locations: LocationScope = { allowed: null, active: null }): T {
  return storage.run({ companyId, locations }, fn);
}

export function currentCompanyIdOrNull(): string | null {
  return storage.getStore()?.companyId ?? null;
}

// Falla si no hay empresa: mejor un error que una consulta sin filtrar
export function currentCompanyId(): string {
  const id = currentCompanyIdOrNull();
  if (!id) throw new Error("Operación sin empresa activa");
  return id;
}

const scopeOf = () => storage.getStore()?.locations ?? { allowed: null, active: null };

// Ubicaciones que se ven ahora: la activa, o todas las suyas. null = todas las de la empresa.
export function locationScope(): string[] | null {
  const { allowed, active } = scopeOf();
  return active ? [active] : allowed;
}

// Ubicaciones donde trabaja la persona (null = todas)
export const allowedLocationIds = () => scopeOf().allowed;

// Ubicación por defecto para registrar algo (la activa); null = la persona tiene que elegir
export const activeLocationId = () => scopeOf().active;

// ¿Puede la persona operar en esa ubicación? (el admin y quien no tiene asignadas, en todas)
export function assertLocationAllowed(locationId: string) {
  const { allowed } = scopeOf();
  if (allowed && !allowed.includes(locationId)) throw new Error("No trabajas en esa ubicación");
}

// Empresa activa de la petición en curso. La fija el middleware Authenticated y la lee
// el cliente de Prisma (config/database.ts) para filtrar todo por empresa.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<{ companyId: string }>();

export function runWithCompany<T>(companyId: string, fn: () => T): T {
  return storage.run({ companyId }, fn);
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

import { z } from "zod"

// Listados paginados: ?page=1&pageSize=25&q=texto. Respuesta { items, total, page, pageSize, pageCount }.
export const PAGE_SIZE_MAX = 100

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
  q: z.string().trim().max(100).optional().transform((v) => v || undefined),
}
export const pageQuerySchema = z.object(pageQuery)
export type PageQuery = { page: number; pageSize: number; q?: string | undefined }

// booleano en la query: "1"/"true" = sí; ausente = no filtra
export const queryFlag = z.enum(["1", "true", "0", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "1" || v === "true"))

export const pageArgs = ({ page, pageSize }: PageQuery) => ({ skip: (page - 1) * pageSize, take: pageSize })

export const pageResult = <T>(items: T[], total: number, { page, pageSize }: PageQuery) => ({
  items,
  total,
  page,
  pageSize,
  pageCount: Math.max(1, Math.ceil(total / pageSize)),
})

// Texto de búsqueda sin distinguir mayúsculas (Postgres ILIKE)
export const contains = (q: string) => ({ contains: q, mode: "insensitive" as const })

// Catálogos chicos (proveedores, clientes, usuarios): con ?page paginan; sin page devuelven la lista
// completa (la usan los selectores de los formularios). q filtra en los dos modos.
export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
  q: pageQuery.q,
})
export type CatalogQuery = z.infer<typeof catalogQuerySchema>

// Ejecuta la consulta en el modo que corresponda
export async function catalogResult<T>(
  f: CatalogQuery,
  count: () => Promise<number>,
  find: (args: { skip?: number; take?: number }) => Promise<T[]>
) {
  if (f.page === undefined) return find({})
  const p = { page: f.page, pageSize: f.pageSize }
  const [total, items] = await Promise.all([count(), find(pageArgs(p))])
  return pageResult(items, total, p)
}

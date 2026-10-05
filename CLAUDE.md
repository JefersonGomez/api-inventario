# Instrucciones — inventario-api (backend)

Antes de leer esto, ya deberías haber leído `../MEMORY.md` (carpeta padre) y `../CLAUDE.md`. Este archivo son las convenciones específicas de este repo.

---

## Stack

Node + TypeScript (ESM) + Express + PostgreSQL (Docker) + Prisma (generador `prisma-client`, driver adapters, TS7).

---

## Arquitectura y convenciones (seguir siempre, sin excepción)

- Patrón **Router → Controller → Service**, por módulo en `src/modules/<nombre>/`.
- Router: solo conecta método+path con el controller, sin lógica.
- Controller: recibe `req`/`res`, llama al service, decide status code. `try/catch` siempre. Nunca habla directo con Prisma.
- Service: lógica de negocio real, habla con Prisma. Los errores se **lanzan** (`throw`), nunca se capturan ahí.
- Validación con Zod vía middleware `validate(schema)` — va **antes** de `Authenticated`/`Authorize` en la cadena de rutas.
- Auth: JWT de acceso corto (env var `JWT_SECRET_KEY` — **no** `JWT_SECRET`, ya hubo bugs de desincronización por esto) + refresh tokens rotativos en tabla `RefreshToken`.
- `Authorize("ADMIN")` o `Authorize("ADMIN", "EMPLOYE")`.
- Soft delete en `Product` y `Category` (`deletedAt`). Todo `findMany`/`findFirst` de estado actual debe filtrar `deletedAt: null`. Los históricos (movimientos, auditoría, solicitudes/órdenes ya creadas) **no** se filtran.
- `name`, `sku`, `barcode` ya no son `@unique` en Prisma — la unicidad la maneja un índice único *parcial* de Postgres (`WHERE deletedAt IS NULL`). Por eso se usa `findFirst`, no `findUnique`, para buscarlos.
- Auditoría: cualquier update/delete relevante (Product, Category, PurchaseRequest, PurchaseOrder, User) debe llamar a `logAudit(...)` del módulo `audit`. Si la operación corre dentro de una transacción Prisma, pasarle el `tx` como último argumento a `logAudit` (y a `createMovement`), para que el log forme parte atómica de esa transacción.
- `exactOptionalPropertyTypes: true` está activo en el tsconfig — nunca asignar `propiedad: valor ?? undefined` pensando que "se omite"; usar el patrón `...(condición && { propiedad })` en el spread del objeto.

---

## Antes de correr comandos de Prisma

- El comando es `npx prisma migrate dev --name <nombre>`, **nunca** `npx prisma generate <algo>` ni `npx generate prisma` (son paquetes npm completamente distintos — ya pasó el error de confundirlos varias veces).
- Si hay que editar el SQL de una migración a mano (ej. un índice único parcial), usar `--create-only` primero, editar el archivo generado, y recién después aplicar con `migrate dev` sin flags.
- Después de cambiar schema + migrar, si aparece un error de TypeScript que no tiene sentido, reiniciar el TS Server del editor antes de seguir investigando.
- `prisma/seed.ts` corre con `tsx` directo, **no** pasa por `server.ts` — si usa `process.env.X`, necesita su propio `dotenv.config()` al principio del archivo.
- Antes de asumir un bug de código ante un error de "columna no existe", correr `npx prisma migrate status` para confirmar que no hay migraciones generadas pero sin aplicar.

---

## Gemini (asistente IA, módulo `assistant`)

- Modelo vigente: `gemini-3.6-flash` (verificar con una búsqueda si volvió a cambiar — Google descontinúa modelos con relativa frecuencia).
- Cada `functionResponse` debe incluir `id` (obligatorio en Gemini 3.x para emparejar con su `functionCall`).
- El turno del modelo con function calls debe reenviarse tal cual vino en `response.candidates[0].content`, nunca reconstruido a mano desde `response.functionCalls` — Gemini 3 agrega un `thought_signature` como hermano de `functionCall` dentro del `Part`, y reconstruirlo a mano lo pierde, causando un 400.
- El asistente es de **solo lectura** — nunca debe ganar tools que ejecuten acciones (crear, editar, borrar).

---

## Checklist antes de dar una tarea de backend por terminada

1. ¿Se actualizó `../MEMORY.md`?
2. Si se tocó un módulo con `findUnique`/`findMany` de Product o Category, ¿se revisó el filtro de `deletedAt`?
3. Si se tocó un service que participa de alguna transacción existente (`receivePurchaseOrder`, por ejemplo), ¿se mantuvo la atomicidad (pasando `tx`)?
4. ¿La ruta nueva quedó montada en `app.ts`? (bug recurrente: escribir el router y olvidar el `app.use(...)`)
5. Si el cambio afecta la forma de una respuesta JSON que el frontend consume, ¿se avisó/ajustó el lado de `inventario-frontend`?
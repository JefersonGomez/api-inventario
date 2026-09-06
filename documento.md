# Plan del Proyecto: Sistema de Inventario (Backend)

Documento de referencia para configurar el proyecto desde cero y para saber cómo seguimos trabajando de aquí en adelante.

---

## 1. Stack definitivo

| Capa | Tecnología |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| Framework | Express |
| Base de datos | PostgreSQL (en Docker) |
| ORM | Prisma (generador nuevo `prisma-client`, con driver adapters) |
| Auth | JWT + bcrypt |
| Validación | Zod (pendiente de integrar) |
| Docs | Swagger (pendiente) |
| Tests | Jest + Supertest (pendiente) |
| Ejecutor dev | `tsx` (no `ts-node-dev`, por compatibilidad con ESM) |

**Decisión clave:** el proyecto usa **ESM** (`import`/`export` nativos), no CommonJS. Esto trae más pasos de configuración inicial, pero es el estándar moderno de Node. Todo lo de la sección 2 existe por esa decisión, combinado con estar usando una versión reciente de Prisma (7+).

---

## 2. Configuración inicial paso a paso (checklist reproducible)

### 2.1 Inicializar proyecto

- `npm init -y` → genera `package.json`.
- Crear estructura de carpetas base:
  ```
  src/config, src/middlewares, src/modules, src/shared/utils, src/shared/errors
  ```
- Crear `.gitignore` con al menos: `node_modules`, `dist`, `.env`, `src/generated`.

### 2.2 TypeScript + ESM

Instalar:
```bash
npm i -D typescript tsx @types/node
npx tsc --init
```

Nota: se usa `tsx` en vez de `ts-node-dev` porque este último tiene soporte limitado/con bugs para ESM.

En `package.json`, agregar:
```json
"type": "module"
```

En `tsconfig.json`, las opciones que sí importan para este proyecto:

| Opción | Valor | Por qué |
|---|---|---|
| `rootDir` | `./src` | Solo el código de la app vive ahí |
| `outDir` | `./dist` | Carpeta de salida al compilar |
| `module` | `NodeNext` | Coherente con ESM real de Node |
| `target` | `ES2022` | Versión moderna de JS |
| `strict` | `true` | Validación de tipos estricta, evita bugs |
| `esModuleInterop` | `true` | Compatibilidad al importar librerías CJS |
| `skipLibCheck` | `true` | No revisa tipos dentro de `node_modules` |
| `allowImportingTsExtensions` | `true` | Necesario para el cliente de Prisma (ver 2.4) |
| `emitDeclarationOnly` o `noEmit` | según necesidad | Requisito de TS al usar la opción anterior |
| `exclude` | `["node_modules", "dist", "prisma", "prisma.config.ts"]` | Evita que TS intente compilar el seed y la config de Prisma bajo las reglas de `rootDir` |

**Regla de ESM que causa más fricción:** toda importación por ruta relativa (`../algo`) debe llevar la extensión del archivo explícita (ej. `.js` o `.ts` según configuración). Con CommonJS esto no sería necesario.

Scripts en `package.json`:
- `dev`: corre `tsx` en modo watch sobre `src/server.ts`.
- `build`: corre `tsc` (compila a `dist`).
- `start`: corre `node` sobre `dist/server.js` (para producción).

### 2.3 Express base

```bash
npm i express dotenv cors helmet
npm i -D @types/express
```

- `src/app.ts`: instancia de Express, `express.json()`, ruta `/health` de prueba, exporta `app`.
- `src/server.ts`: importa `app`, carga `dotenv` lo antes posible, llama `.listen()`.
- Separar `app.ts` de `server.ts` es importante para poder testear con Supertest sin levantar un puerto real.

### 2.4 Docker (Postgres)

Crear `.env` con al menos:
```
PORT=3000
DATABASE_URL=postgresql://usuario:contraseña@localhost:5432/inventario_db
JWT_SECRET=algo_largo_y_random
ADMIN_INITIAL_PASSWORD=clave_temporal_segura
```

Crear `docker-compose.yml` con un servicio de Postgres:
- `image: postgres:16` (o la versión que uses).
- `environment`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` (deben coincidir con tu `DATABASE_URL`).
- `ports`: `5432:5432`.
- `volumes`: un volumen con nombre montado hacia `/var/lib/postgresql/data`, para que los datos persistan aunque borres el contenedor.

Comandos clave:
```bash
docker-compose up -d      # levanta en segundo plano
docker-compose ps         # verifica estado
docker-compose logs postgres  # revisa logs si algo falla
docker-compose down       # detiene (sin -v no borra el volumen/datos)
```

**Flujo de trabajo diario:** levantar Docker una vez y dejarlo corriendo; no hace falta bajarlo cada vez que cierras el proyecto.

### 2.5 Prisma (versión nueva, con driver adapters)

```bash
npm i -D prisma
npm i @prisma/client
npm i @prisma/adapter-pg
npx prisma init
```

En `schema.prisma`, el bloque generator queda así (generador nuevo, orientado a ESM):
```
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
  moduleFormat = "esm"
  generatedFileExtension = "ts"
  importFileExtension = "ts"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Las últimas dos líneas del generator (`generatedFileExtension`, `importFileExtension`) son las que evitan errores de módulos no encontrados por mezclar `.ts`/`.js` en un entorno `tsx` + ESM.

**Definir los modelos** (`User`, `Category`, `Product`, `StockMovement`) y los enums (`Role`, `MovementType`) siguiendo la lógica de:
- `@id @default(uuid())` para llaves primarias.
- `@unique` en campos que no deben repetirse (ej. email de usuario).
- `@default(now())` / `@updatedAt` para fechas automáticas.
- Relaciones: el lado "muchos" guarda el campo FK + `@relation(fields: [...], references: [...])`; el lado "uno" solo declara una lista del otro modelo.
- `@db.Decimal(10,2)` para precios (nunca `Float`).

**Conexión con driver adapter** (`src/config/database.ts`):
- Crear una instancia de `PrismaPg` pasándole `{ connectionString: process.env.DATABASE_URL }`.
- Crear el `PrismaClient` pasándole `{ adapter }`.
- Exportar una única instancia compartida (patrón singleton) — nunca crear una instancia nueva en cada archivo.

**Migraciones:**
```bash
npx prisma migrate dev --name init
```
Esto compara el schema contra la base de datos real, genera el SQL en `prisma/migrations/`, y lo aplica. También regenera el cliente automáticamente.

**Ver los datos visualmente:**
```bash
npx prisma studio
```

**Seed (admin inicial):**
- El seed vive en `prisma/seed.ts`, es un script (no un handler HTTP) que se ejecuta una sola vez desde terminal.
- Estructura: función `async main()` con `try/catch/finally`, cerrando la conexión con `await prisma.$disconnect()` dentro del `finally`.
- Debe ser idempotente: verificar primero si ya existe un admin (`findFirst`/`findUnique`) antes de crear uno nuevo.
- Configurar en `prisma.config.ts` (no en `package.json`, eso cambió en versiones recientes de Prisma):
  ```typescript
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  }
  ```
- Ejecutar con: `npx prisma db seed`.

---

## 3. Errores típicos ya resueltos (para no repetirlos)

| Síntoma | Causa | Solución |
|---|---|---|
| `Cannot find module` en imports relativos | ESM exige extensión explícita | Agregar extensión al import, o ajustar `importFileExtension` en Prisma |
| `An import path can only end with a '.ts' extension...` | Falta permiso en TS | `allowImportingTsExtensions: true` + `noEmit` o `emitDeclarationOnly` |
| `Expected 1 arguments, but got 0` en `new PrismaClient()` | Prisma 7+ exige driver adapter | Instalar `@prisma/adapter-pg`, pasar `{ adapter }` |
| `No seed command configured` | Prisma ya no usa `package.json` para seed | Configurar `migrations.seed` en `prisma.config.ts` |
| `File is not under 'rootDir'` | `seed.ts`/`prisma.config.ts` fuera de `src` | Agregarlos a `exclude` en `tsconfig.json` |
| `'X' is a type and must be imported using a type-only import` | `verbatimModuleSyntax: true` | Usar `import type { ... }` para tipos (ej. `Request`, `Response`) |

---

## 4. Arquitectura y patrón de trabajo (cómo seguimos)

Cada módulo de negocio (auth, products, categories, movements, reports) sigue el mismo patrón en capas:

```
Router → Controller → Service → Prisma → DB
```

- **Router**: solo conecta método+path con una función del controller. Sin lógica.
- **Controller**: recibe `req`/`res`, extrae datos, llama al service, decide status code + respuesta. Nunca habla directo con Prisma. Usa `try/catch` para capturar errores lanzados por el service.
- **Service**: lógica de negocio real, habla con Prisma. Nunca conoce `req`/`res`. Los errores se **lanzan** (`throw`), no se capturan aquí — el controller decide qué responder.

Carpeta por módulo dentro de `src/modules/<nombre>/`:
```
<nombre>.routes.ts
<nombre>.controller.ts
<nombre>.service.ts
```

**Reglas de seguridad ya aplicadas:**
- Contraseñas nunca se guardan en texto plano — se hashean con `bcrypt` (10 salt rounds).
- El `passwordHash` nunca se devuelve en respuestas — usar `select` de Prisma para elegir explícitamente los campos de salida.
- El primer admin se crea solo vía seed, nunca por registro público (registro público siempre crea `EMPLOYEE`/rol base).

---

## 5. Progreso actual

- [x] Proyecto Node + TS + ESM configurado
- [x] Express corriendo con ruta de salud
- [x] Docker + Postgres persistiendo datos
- [x] Prisma con schema, migración inicial, cliente conectado con adapter
- [x] Seed de admin inicial (idempotente)
- [x] `POST /auth/register` (Router → Controller → Service) funcionando
- [x] `POST /auth/login` (JWT) funcionando
- [x] Middleware de autenticación (`Authenticated`) — verifica JWT, llena `req.user`
- [x] Middleware de roles (`Authorize`) — factory function, recibe roles permitidos por rest params
- [x] `GET /auth/me` como ruta de prueba (validada con Postman)
- [x] Validación de inputs con Zod (auth, categories, products, movements)
- [x] CRUD de productos y categorías
- [x] Movimientos de stock
- [x] Reportes (low-stock, movements por rango de fechas, inventory-value)
- [ ] Swagger
- [ ] Tests (Jest + Supertest)
- [ ] Deploy

---

## 5.1 Notas técnicas del módulo de Auth (para no repetir la investigación)

**JWT — payload y verificación:**
- Al firmar (`jwt.sign`), el payload debe ser mínimo: `{ id, role }`. Nunca meter `passwordHash` ni datos sensibles (el payload no está encriptado, solo firmado).
- Al verificar (`jwt.verify`), el tipo de retorno es `string | JwtPayload` — hace falta una aserción (`as AuthPayload`) porque TypeScript no puede inferir la forma exacta del payload propio.
- El nombre de la variable de entorno del secreto debe ser **idéntico** en `Login` (donde se firma) y en `Authenticated` (donde se verifica) — un typo entre `JWT_SECRET` y `JWT_SECRET_KEY` hace que la verificación silenciosamente use el valor por defecto y nunca falle "bonito", sino con mensajes confusos.

**Extender tipos de Express (`req.user`):**
- Se declara en un archivo `.d.ts` (ej. `src/types/express.d.ts`) usando `declare global { namespace Express { interface Request { user?: AuthPayload } } }`.
- No requiere import en otros archivos para que la extensión de `Request` funcione (es ambiental/global). Solo se importa el tipo `AuthPayload` si se quiere usar explícitamente en otro archivo.

**Middleware de autenticación (`Authenticated`):**
- Lee `req.headers.authorization`, separa `"Bearer <token>"` con `.split(" ")[1]`.
- Errores comunes en Postman: mandar el token sin la palabra `Bearer`, o usar la pestaña dedicada de Authorization (que ya antepone `Bearer` sola) y además escribirlo manual en headers — hay que usar una sola vía.
- `jwt.verify` lanza excepción si el token es inválido/expiró → capturarla en `catch` y responder 401.

**Middleware de roles (`Authorize`):**
- Es una *factory function*: recibe roles permitidos vía rest params (`...rolesPermitidos: string[]`) y retorna el middleware real.
- Debe ir siempre **después** de `Authenticated` en la cadena de una ruta (`Authenticated` llena `req.user`, `Authorize` lo lee).
- Verifica pertenencia con `.includes()`. Si `req.user` no existe → 401 (defensivo). Si el rol no está permitido → 403 (autenticado pero sin permiso).

**Patrón repetido a lo largo del proyecto:** si el Service usa `throw` para señalar errores, el Controller no necesita revalidar el resultado con `if` — solo necesita el `try/catch`. Aplica igual a middlewares: si `jwt.verify`/Prisma garantizan lanzar en caso de fallo, no hace falta un `if` extra sobre el resultado exitoso.

---

## 5.2 Bugs recurrentes a vigilar en cada nuevo CRUD

Errores que ya se repitieron más de una vez al construir categories/products — revisar siempre al escribir un CRUD nuevo:

- **Lógica de `if` invertida sobre resultados de Prisma:** `findMany()` siempre devuelve un array (vacío o no) — nunca es un caso de error. `update()`/`delete()`/`create()` **lanzan excepción sola** si algo falla (no hace falta revalidar con `if` después). Solo `findUnique()`/`findFirst()` devuelven `null` cuando no encuentran nada, y ahí sí corresponde un `if (x == null) throw`.
- **`req.params` sin destructurar:** `const id = req.params` guarda el objeto completo, no el valor. Siempre `const { id } = req.params`.
- **Falta de `return` al final del service:** sobre todo en `delete`, es fácil olvidarlo.
- **Convención REST para el id del recurso:** siempre en la URL (`/:id`), nunca en el body, para `GET`/`PUT`/`DELETE` de un recurso específico.
- **Prefijos de rutas consistentes:** confirmar que el `app.use("/prefijo", router)` en `app.ts` coincide exactamente (singular/plural) con lo que se prueba en Postman.
- **No incluir el `id` dentro de `data` en un `update`** — el `id` va solo en `where`.
- **Validar existencia de relaciones antes de crear/actualizar** (ej. `categoryId` en `Product`) para dar un mensaje de error claro en vez del error crudo de la foreign key de Prisma.

---

## 5.3 Notas técnicas de validación con Zod

- **Versión reciente de Zod (v4):** varios validadores de formato que antes eran encadenados sobre `z.string()` ahora son funciones de nivel superior: `z.string().email()` → `z.email()`; mismo patrón para `z.uuid()`, etc.
- **`ZodSchema` está deprecado** en favor de `ZodType` como tipo genérico para tipar un parámetro que reciba "cualquier schema".
- **Middleware genérico reusable** (`validate(schema)`): factory function, usa `schema.safeParse(req.body)` (no `.parse()`, porque no lanza excepción — devuelve `{ success, data | error }`, más fácil de manejar en un middleware). Si es válido, reemplaza `req.body` con `result.data` antes de `next()`.
- **Orden de middlewares:** `validate(schema)` va primero, antes de `Authenticated`/`Authorize` — validar el input es más barato que verificar un JWT, y no depende de la autenticación.
- **El schema de `update` no siempre es igual al de `create`:** revisar qué campos acepta realmente el Service correspondiente antes de copiar el schema de create (ej. `stock` no es editable en productos, así que no debe exigirse en el schema de update).
- **Los valores de un enum de Zod (`z.enum([...])`) deben coincidir exactamente** con los valores reales del enum de Prisma — un typo hace que Zod rechace valores que en realidad son válidos para la base de datos.

---

## 6. Cómo seguimos trabajando (metodología)

Para cada nueva funcionalidad:
1. Se explica el concepto/flujo antes de tocar código.
2. Se identifican los pasos en texto plano (en español, sin sintaxis) antes de programar.
3. Se escribe primero el **Service** (lógica pura), después el **Controller**, después las **Routes**.
4. Se dan pistas de qué método/función se necesita (sin el código completo) para que el usuario lo escriba.
5. Se revisa lo escrito, se corrige, y se explica el porqué de cada corrección.
6. Se prueba el flujo completo antes de pasar al siguiente módulo.

Objetivo: que el usuario entienda cada pieza para depender cada vez menos de la IA a futuro.
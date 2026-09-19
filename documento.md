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
| Validación | Zod |
| Docs | Swagger |
| Tests | Jest + Supertest |
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

**Definir los modelos** (`User`, `Category`, `Product`, `StockMovement`, y desde la Fase 5 también `Supplier`, `PurchaseRequest`, `PurchaseOrder`, `PurchaseOrderItem`) y los enums (`Role`, `MovementType`, `PurchaseRequestStatus`, `PurchaseOrderStatus`) siguiendo la lógica de:
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

Cada módulo de negocio (auth, products, categories, movements, reports, suppliers, purchase-requests, purchase-orders) sigue el mismo patrón en capas:

```
Router → Controller → Service → Prisma → DB
```

- **Router**: solo conecta método+path con una función del controller. Sin lógica.
- **Controller**: recibe `req`/`res`, extrae datos, llama al service, decide status code + respuesta. Nunca habla directo con Prisma. Usa `try/catch` para capturar errores lanzados por el service.
- **Service**: lógica de negocio real, habla con Prisma. Nunca conoce `req`/`res`. Los errores se **lanzan** (`throw`), no se capturan aquí — el controller decide qué responder.

Carpeta por módulo dentro de `src/modules/<nombre>/`:
```
<nombre>.routes.ts (o <nombre>.router.ts, según el módulo)
<nombre>.controller.ts
<nombre>.service.ts
<nombre>.schema.ts
```

**Reglas de seguridad ya aplicadas:**
- Contraseñas nunca se guardan en texto plano — se hashean con `bcrypt` (10 salt rounds).
- El `passwordHash` nunca se devuelve en respuestas — usar `select` de Prisma para elegir explícitamente los campos de salida.
- El primer admin se crea solo vía seed, nunca por registro público (registro público siempre crea `EMPLOYE`/rol base).

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
- [x] Validación de inputs con Zod (auth, categories, products, movements, purchase-requests, purchase-orders)
- [x] CRUD de productos y categorías
- [x] Movimientos de stock
- [x] Reportes (low-stock, movements por rango de fechas, inventory-value)
- [x] Swagger (openapi.yaml, servido en /api-docs)
- [x] Tests (Jest + Supertest) — 13 tests pasando: auth (register/login), middleware Authenticated, movements (IN/OUT/ADJUSTMENT con transacciones). **Pendiente:** agregar cobertura de tests para purchase-requests y purchase-orders, construidos después de la última corrida de tests.
- [x] Proveedores (CRUD completo, backend + frontend)
- [x] Solicitudes de compra (`PurchaseRequest`) — CRUD con filtrado por rol
- [x] Órdenes de compra (`PurchaseOrder`) — CRUD + recepción transaccional con impacto real en stock
- [x] Sistema de alertas de solicitudes de compra (vencimiento próximo + aprobadas sin orden) — funcionalidad agregada durante la Fase 5, no estaba en el plan original
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
- **`AuthPayload.role` está tipado como `string`, no como el enum `Role` de Prisma.** Esto genera un error de tipos recurrente en cualquier service nuevo que reciba `req.user` y espere `role: Role` (surgió primero en `purchase-requests`). Solución aplicada: tipar la firma del service que recibe el usuario como `{ id: string; role: string }` en vez de importar `Role`. **Repetir esta misma solución en cualquier módulo nuevo que reciba `req.user`.** Mejora pendiente para el futuro: hacer que `express.d.ts` importe `Role` de Prisma directamente para `AuthPayload`, centralizando el fix en un solo lugar.

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

Errores que ya se repitieron más de una vez al construir categories/products/purchase-requests/purchase-orders — revisar siempre al escribir un CRUD nuevo:

- **Lógica de `if` invertida sobre resultados de Prisma:** `findMany()` siempre devuelve un array (vacío o no) — nunca es un caso de error. `update()`/`delete()`/`create()` **lanzan excepción sola** si algo falla (no hace falta revalidar con `if` después). Solo `findUnique()`/`findFirst()` devuelven `null` cuando no encuentran nada, y ahí sí corresponde un `if (x == null) throw`.
- **`req.params` sin destructurar:** `const id = req.params` guarda el objeto completo, no el valor. Siempre `const { id } = req.params`.
- **`req.params.id` se tipa como `string | string[] | undefined`** en Express con TypeScript (no solo `string | undefined`) — siempre tipar el handler como `Request<{ id: string }>` y validar con `if (!id || typeof id !== "string")` antes de pasarlo a una función que espera `string`, para que TypeScript reduzca el tipo (type narrowing). Aplicado de forma consistente en `purchase-requests` y `purchase-orders`.
- **Falta de `return` al final del service:** sobre todo en `delete`, es fácil olvidarlo.
- **Convención REST para el id del recurso:** siempre en la URL (`/:id`), nunca en el body, para `GET`/`PUT`/`DELETE` de un recurso específico.
- **Prefijos de rutas consistentes:** confirmar que el `app.use("/prefijo", router)` en `app.ts` coincide exactamente (singular/plural) con lo que se prueba en Postman/frontend. **Causa confirmada de un 404 real en Fase 5:** los routers de `purchase-requests`/`purchase-orders` se escribieron pero no se montaron en `app.ts` a tiempo — siempre confirmar el `app.use(...)` antes de asumir que el bug está en el frontend.
- **No incluir el `id` dentro de `data` en un `update`** — el `id` va solo en `where`.
- **Validar existencia de relaciones antes de crear/actualizar** (ej. `categoryId` en `Product`, `supplierId`/`productId` en `PurchaseOrder`) para dar un mensaje de error claro en vez del error crudo de la foreign key de Prisma. En `createPurchaseOrder` esto se hizo con una sola query `findMany({ where: { id: { in: [...] } } })` para validar todos los productos de las líneas a la vez, evitando N+1 queries.
- **Rutas específicas antes que rutas con `:id`:** si un router tiene un endpoint fijo (ej. `GET /alerts`) y en el futuro se agrega un `GET /:id`, el fijo debe declararse **antes** en el archivo de rutas, o Express intenta interpretar el segmento fijo como el parámetro dinámico.

---

## 5.3 Notas técnicas de validación con Zod

- **Versión reciente de Zod (v4):** varios validadores de formato que antes eran encadenados sobre `z.string()` ahora son funciones de nivel superior: `z.string().email()` → `z.email()`; mismo patrón para `z.uuid()`, etc.
- **`ZodSchema` está deprecado** en favor de `ZodType` como tipo genérico para tipar un parámetro que reciba "cualquier schema".
- **Middleware genérico reusable** (`validate(schema)`): factory function, usa `schema.safeParse(req.body)` (no `.parse()`, porque no lanza excepción — devuelve `{ success, data | error }`, más fácil de manejar en un middleware). Si es válido, reemplaza `req.body` con `result.data` antes de `next()`.
- **Orden de middlewares:** `validate(schema)` va primero, antes de `Authenticated`/`Authorize` — validar el input es más barato que verificar un JWT, y no depende de la autenticación. Aplicado consistentemente en `purchase-requests`/`purchase-orders`.
- **El schema de `update` no siempre es igual al de `create`:** revisar qué campos acepta realmente el Service correspondiente antes de copiar el schema de create (ej. `stock` no es editable en productos; el cambio de estado de una `PurchaseRequest` solo acepta `APPROVED`/`REJECTED`, nunca `PENDING`, para que nadie pueda "reabrir" una solicitud vía este endpoint).
- **Los valores de un enum de Zod (`z.enum([...])`) deben coincidir exactamente** con los valores reales del enum de Prisma — un typo hace que Zod rechace valores que en realidad son válidos para la base de datos.
- **Arrays no vacíos:** usar `.nonempty()` en schemas de array cuando la lógica de negocio lo exige (ej. `items` de una `PurchaseOrder` no puede estar vacío).

---

## 5.4 Notas técnicas de Testing (Jest + Supertest + ESM)

**Instalación:**
```bash
npm i -D jest @types/jest ts-jest supertest @types/supertest
```

**Conflicto conocido: TypeScript 7 vs ts-jest.** `ts-jest` aún no soporta la nueva API del compilador nativo de TS7. Solución oficial (alias de paquetes):
```bash
npm install --save-dev "@typescript/native@npm:typescript@^7.0.2" "typescript@npm:@typescript/typescript6@^6.0.2"
```
Esto mantiene TS7 real bajo `@typescript/native` (para `npx tsc`) y expone una capa de compatibilidad TS6 bajo el nombre `typescript` (lo que `ts-jest` necesita como peer dependency).

**`tsconfig.json` necesita `"types": ["jest"]`** — si `types` está en `[]` (como se configuró para no cargar tipos automáticamente), hay que agregar `"jest"` explícitamente o `describe`/`it`/`expect` no se reconocen como globals.

**`jest.config.js` para proyecto ESM:** usar `createDefaultEsmPreset` (no `createDefaultPreset`, que es para CommonJS — causa `SyntaxError: Unexpected token 'export'`), más un `moduleNameMapper` para resolver los imports que terminan en `.js` hacia los archivos `.ts` reales:
```javascript
import { createDefaultEsmPreset } from "ts-jest";
const presetConfig = createDefaultEsmPreset();

export default {
  ...presetConfig,
  testEnvironment: "node",
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  setupFiles: ["<rootDir>/jest.setup.ts"]
};
```

**Script de test** necesita la bandera experimental de Node para VM Modules:
```json
"test": "node --experimental-vm-modules node_modules/.bin/jest"
```

**Base de datos separada para tests:**
- Una segunda base de datos (`inventario_db_test`) dentro del mismo contenedor de Postgres.
- `.env.test` con su propio `DATABASE_URL` apuntando a esa base.
- `jest.setup.ts` carga ese archivo antes de cualquier test: `dotenv.config({ path: ".env.test" })`.
- Para aplicar migraciones a la base de test manualmente (Windows/PowerShell): sobreescribir la variable solo para esa sesión de terminal y usar `migrate deploy` (no `migrate dev`, que es para desarrollo):
  ```powershell
  $env:DATABASE_URL="...inventario_db_test"; npx prisma migrate deploy
  ```
  Cerrar esa terminal después, ya que la variable queda pegada a la sesión y afectaría a `npm run dev` si se reusa.

**Patrón de test contra rutas con Prisma:**
- Importar `app` (nunca `server.ts`, para no levantar un puerto real), `request` de `supertest`, y la instancia de `prisma` para limpieza.
- `afterEach`: limpiar los datos de prueba creados (usar `deleteMany`, no `delete` — no lanza error si no encuentra nada).
- `afterAll`: `await prisma.$disconnect()`, para que Jest no quede colgado por conexiones abiertas.
- Probar tanto el camino feliz (201/200 y forma esperada del body) como el de error (400 con datos inválidos/duplicados).
- Verificar explícitamente que campos sensibles (`passwordHash`) no vengan en la respuesta (`toBeUndefined()`).

**Los tests como detector de "schema drift":** si el `schema.prisma` se edita (ej. corregir un typo de un nombre de campo) sin correr `migrate dev` después, la base de datos real se queda desactualizada silenciosamente — Postgres seguirá teniendo el nombre/restricción viejo. Los tests que sí ejercitan esas rutas (a diferencia de probar solo manualmente de vez en cuando) detectan esto rápido, con errores como `"The column (not available) does not exist"`. Ante ese mensaje vago, comparar directamente el `migration.sql` ya aplicado contra el `schema.prisma` actual, campo por campo, en vez de adivinar.

**Pendiente:** el módulo `purchase-requests`/`purchase-orders` se construyó y se probó manualmente (Postman/UI), pero todavía no tiene tests automatizados — el caso más importante a cubrir es `receivePurchaseOrder` recibiendo la misma orden dos veces (debe rechazar la segunda con 400 y no duplicar `StockMovement`).

## 5.5 Notas técnicas de Swagger (OpenAPI, archivo YAML separado)

**Instalación:**
```bash
npm i swagger-ui-express yaml
npm i -D @types/swagger-ui-express
```
(No hace falta `swagger-jsdoc` — esa librería es solo para el enfoque de anotaciones en el código, que no se usó aquí.)

**Conexión en `app.ts`:** leer el YAML con `fs.readFileSync`, parsearlo con `parse()` del paquete `yaml`, y montarlo con:
```typescript
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(documentoParseado))
```

**Estructura del documento (`openapi.yaml`):**
- `info` / `servers`: metadata y URL base.
- `components.securitySchemes.bearerAuth`: define el esquema JWT una sola vez (`type: http`, `scheme: bearer`, `bearerFormat: JWT`). Se activa por ruta con `security: [{ bearerAuth: [] }]` — esto es lo que habilita el botón "Authorize" en la UI.
- `components.schemas`: define la forma de cada modelo/input una sola vez (`Category`, `Product`, `MovementInput`, etc.) y se reutiliza en cualquier `path` con `$ref: '#/components/schemas/NombreDelSchema'` — evita repetir `properties` en cada endpoint.

**Errores comunes de sintaxis YAML (estricta con espaciado):**
- Siempre un espacio después de `:` entre clave y valor.
- Las listas (`servers`, `tags`, `required`, elementos de un array) necesitan el guion `-` seguido de un espacio antes del valor.
- Las claves del estándar (`requestBody`, `description`, etc.) van siempre en inglés, sin importar el idioma del contenido.

**Pendiente:** agregar los schemas y paths de `purchase-requests`/`purchase-orders` al `openapi.yaml` — no se hizo durante la Fase 5, quedó cubierto solo por pruebas manuales.

---

## 5.6 Notas técnicas de Purchase Requests / Purchase Orders (Fase 5)

**Alcance construido:** CRUD completo de `PurchaseRequest` (solicitud interna, la crea EMPLOYE o ADMIN) y `PurchaseOrder` (orden real al proveedor, solo ADMIN), con recepción transaccional que impacta stock, más un sistema de alertas agregado durante esta misma fase.

**Decisión de negocio clave:** aprobar una `PurchaseRequest` **NO** sube el stock. Son dos eventos distintos, a propósito:
- `PurchaseRequest` aprobada = autorización interna para comprar; no implica que la mercadería ya llegó.
- El stock solo sube en `receivePurchaseOrder`, porque representa el evento físico real (la mercadería llegó a la bodega). Esto mantiene la trazabilidad de `StockMovement` consistente: cada movimiento corresponde siempre a un hecho físico, nunca a un paso administrativo.

**`createMovement` extendido para reutilización transaccional:**
`movements.service.ts` → `createMovement` acepta ahora un 6º parámetro opcional `client` (tipo `Prisma.TransactionClient | typeof prisma`, default `prisma`). Sin ese parámetro se comporta igual que antes (usa `$transaction([...])` en array, atómico por sí solo). Con un `tx` de una transacción externa (caso `receivePurchaseOrder`), ejecuta las operaciones dentro de esa transacción más grande sin volver a envolver. Esto evita duplicar la lógica de "sumar/restar stock + crear movimiento" entre `movements.service.ts` y `purchase-order.service.ts`.

**`receivePurchaseOrder` — transacción completa:**
1. Lee la orden con sus `items`, dentro de `prisma.$transaction(async (tx) => {...})`.
2. Rechaza si `status !== "PENDING"` (evita recibir la misma orden dos veces).
3. Por cada línea, llama a `createMovement(..., tx)` (tipo `IN`).
4. Actualiza `status: "RECEIVED"` y `receivedAt: new Date()`.

Si cualquier paso falla (ej. un producto de la orden fue borrado mientras tanto), toda la transacción revierte — no quedan movimientos fantasma ni la orden marcada como recibida sin stock actualizado.

**Validaciones en `createPurchaseOrder`** (antes de tocar la base con `create`):
- Existencia de `supplierId`.
- Existencia de todos los `productId` de las líneas, en una sola query.
- Rechaza `productId` duplicados entre líneas de la misma orden (decisión de negocio a revisar si cambia en el futuro: hoy no se permiten dos líneas del mismo producto, ni siquiera a distinto costo unitario).
- Si vienen `fulfilledRequestIds`: valida que cada solicitud exista, esté `APPROVED`, y no esté ya vinculada a otra orden.

**Sistema de alertas (funcionalidad nueva, no estaba en el plan original):**
- `PurchaseRequest.expiresAt` (`DateTime?`, default `now() + 7 días` si no se especifica al crear) — solo tiene sentido mientras la solicitud está `PENDING`.
- `PurchaseRequest.purchaseOrderId` (`String?`, FK opcional a `PurchaseOrder`) — se llena cuando una orden de compra "cubre" esa solicitud (vía `connect` al crear la orden con `fulfilledRequestIds`). Permite saber qué solicitudes `APPROVED` todavía no tienen una orden real asociada.
- Endpoint `GET /purchase-requests/alerts` (solo ADMIN) devuelve `{ expiringSoon, approvedUnfulfilled }`.
- Frontend: hook `usePurchaseRequestAlerts` (`src/hooks/usePurchaseRequestAlerts.js`) con `refetchInterval: 60_000`, badge de conteo en el Sidebar sobre "Órdenes de compra", y una card en el Dashboard con links directos a cada módulo.
- **No incluye notificación por email/push** — eso requiere un job scheduler (cron), que no existe todavía en el proyecto. Evaluar si se agrega en la Fase 6.

**Bug de plataforma (Base UI, no Radix):**
`DialogTrigger`/`AlertDialogTrigger` con `asChild` causaban `<button>` anidado y error de hidratación. El preset de shadcn de este proyecto usa Base UI, que no soporta `asChild` — usa la prop `render`. Corregido en `PurchaseRequests.jsx` y `PurchaseOrders.jsx`:
```jsx
<DialogTrigger render={<Button>...</Button>} />
```
Ya estaba anotado para `DropdownMenuTrigger` en las notas de Fase 1/2 (sección 7) — confirmado que aplica igual a `Dialog` y `AlertDialog`, y a cualquier primitivo nuevo de este stack.

**Pendiente de confirmar:** verificar con datos reales que el badge del Sidebar y la card del Dashboard se refrescan correctamente después de vincular una solicitud a una orden nueva (debería desaparecer de `approvedUnfulfilled` sin recargar la página, gracias al `invalidateQueries` + el polling de 60s). Confirmar también con Postman/curl (no solo desde la UI) que `PATCH /purchase-orders/:id/receive` rechaza un segundo intento sobre la misma orden.

---

## 7. Frontend (inventario-frontend/)

Proyecto separado, al mismo nivel que el backend (`inventario-api/`).

### Stack

| Capa | Tecnología |
|---|---|
| Framework | React + Vite (JavaScript, sin TS) |
| Estilos | TailwindCSS + shadcn/ui (Base UI, preset Vega) |
| Routing | react-router-dom |
| Llamadas a la API | axios + @tanstack/react-query |
| Estado global (auth) | Context API (nativo) |
| Iconos | lucide-react |

### Dirección visual (aprobada)

Dashboard oscuro estilo "admin panel", inspirado en una referencia con sidebar fijo + cards de métricas + gráficos + tabla. Mockup de referencia: `mockup-dashboard.html`.

- **Paleta:** fondo casi negro con tinte morado (`#0B0A14`), cards (`#151325`) con borde sutil (`#221F3B`, sin sombras), acento morado (`#8B7CF6`).
- **Layout:** sidebar fijo en desktop (logo, nav, perfil de usuario abajo) + topbar (buscador, notificaciones, avatar) + contenido principal.
- **Responsividad (mobile-first, breakpoints de Tailwind):**
  - Móvil (< 768px): sidebar oculto por defecto, se despliega como overlay con botón de menú hamburguesa. Cards en 1 columna. Tabla con scroll horizontal.
  - Tablet (768–1024px): cards en 2 columnas, gráficos apilados.
  - Desktop (> 1024px): layout completo, sidebar fijo, cards en 4 columnas, gráficos lado a lado.
- **Contenido del dashboard:** métricas (total productos, stock bajo, valor de inventario, movimientos hoy), gráfico de barras de movimientos (entradas vs salidas), dona de stock por categoría, tabla de productos con stock bajo (badges Crítico/Bajo/Normal según `minStock`), y desde la Fase 5, la card de alertas de solicitudes de compra.

### Progreso

- [x] Definición de stack y dirección visual (mockup aprobado)
- [x] Inicialización del proyecto (Vite + React + JS)
- [x] Tailwind + shadcn/ui configurados (preset Vega, paleta oscura/morada personalizada)
- [x] Estructura de carpetas
- [x] Routing base (react-router-dom) + rutas protegidas (ProtectedRoute)
- [x] Context de autenticación (login, token, usuario, persistencia en localStorage)
- [x] Cliente axios (interceptor de token) + React Query configurados
- [x] Layout principal (sidebar + topbar responsivo, Sheet para móvil)
- [x] Pantalla de login y registro, conectadas al backend real
- [x] Botón de logout en el Topbar (DropdownMenu con datos del usuario)
- [x] Dashboard con métricas reales (total productos, stock bajo, valor de inventario) vía useQuery
- [x] CRUD de categorías (UI) — tabla + Dialog crear/editar + AlertDialog confirmación de borrado
- [x] CRUD de productos (UI) — con selector de categoría (usando prop `items` de Select), stock no editable en update
- [x] Registro de movimientos (UI) — formulario IN/OUT/ADJUSTMENT, invalida products y reports al crear
- [x] Reportes (UI) — valor de inventario, stock bajo, movimientos filtrados por rango de fechas
- [x] Proveedores (UI) — CRUD completo con UI condicional por rol
- [x] Solicitudes de compra (UI) — crear, listar (filtrado por rol), aprobar/rechazar
- [x] Órdenes de compra (UI) — formulario de líneas repetibles, recepción con confirmación, vínculo opcional con solicitudes aprobadas
- [x] Alertas de solicitudes de compra — badge en Sidebar + card en Dashboard

### Fase 1: Perfil y configuración — COMPLETA

- [x] Foto de perfil (multer en backend, subida vía FormData, mostrada en Topbar y Profile, sincronizada con `updateUser` del AuthContext)
- [x] Mostrar rol en la UI (Badge en Profile y en tabla de Users)
- [x] Cambio de contraseña (verifica contraseña actual antes de permitir el cambio)
- [x] Edición de perfil (nombre/email) — patrón `EditableRow`: fila con label + valor, "Editar" activa un input inline con Guardar/Cancelar
- [x] Idioma ES/EN (react-i18next, selector persistente en Configuración vía localStorage)
- [x] Modo oscuro/claro (ThemeContext propio, toggle en Configuración, persiste en localStorage)

### Fase 2: Gestión de usuarios (admin) — COMPLETA

- [x] Modelo `User` con campo `isActive` (default `true`)
- [x] Admin ve lista de empleados con foto, rol, fecha de registro
- [x] Activar/desactivar usuarios — regla: un admin no puede desactivarse a sí mismo, pero sí a otros admins
- [x] `Authenticated` valida `isActive` contra la BD en cada petición (revocación inmediata, no espera a que expire el JWT)
- [x] `Login` rechaza cuentas desactivadas con mensaje explícito (validado después de comprobar la contraseña, para no filtrar el estado de la cuenta a quien no la conoce)
- [x] `AdminRoute` en el frontend (redirige a quien no sea ADMIN si intenta entrar a `/users` por URL directa)

### Fase 5: Proveedores y órdenes de compra — COMPLETA

- [x] Categorías con descripción
- [x] Gráficos reales (recharts) + escaneo de código de barras
- [x] Proveedores, solicitudes y órdenes de compra (ver detalle técnico en sección 5.6 del backend)
- [x] Sistema de alertas (ampliación no planeada originalmente)

### Pendiente (fases futuras acordadas)

- [ ] Refresh tokens, soft delete (productos/categorías), auditoría (Fase 6)
- [ ] Asistente IA (modo solo lectura, function calling sobre reportes/productos) (Fase 7)

### Notas técnicas del frontend

- **shadcn CLI nueva versión (con "Base UI" y presets con nombre — Vega, Nova, Mira, etc.):** requiere `jsconfig.json` con alias `@/*` (proyecto JS, no TS) + `resolve.alias` en `vite.config.js`. En ESM, `__dirname` no existe — reconstruir con `path.dirname(fileURLToPath(import.meta.url))`.
- **Tailwind v4 + shadcn:** las variables de color (`--background`, `--card`, etc.) deben ir dentro de un bloque `@theme inline` (que las mapea a `--color-*`) para que clases como `bg-background` funcionen. Sin ese bloque, los estilos no se aplican aunque las variables existan.
- **`useState` con inicialización perezosa** (`useState(() => localStorage.getItem(...))`) para leer `localStorage` al iniciar el AuthContext, evitando el antipatrón de `setState` síncrono dentro de un `useEffect`.
- **CORS:** el paquete `cors` se instaló en el backend desde el principio pero nunca se activó — hay que agregar `app.use(cors({ origin: "http://localhost:5173" }))` en `app.ts`, antes de los routers, para que el navegador permita peticiones cross-origin del frontend (puerto 5173) al backend (puerto 3000).
- **shadcn con Base UI (no Radix) — patrón `render` en vez de `asChild`:** al componer un trigger con un componente propio (ej. `Button` dentro de `DropdownMenuTrigger`, `DialogTrigger`, `AlertDialogTrigger`), `asChild` puede duplicar el `<button>` (uno propio del primitivo + el de tu componente), causando `<button>` anidado (HTML inválido) y warnings de hidratación. La forma correcta en Base UI es pasar el componente como prop `render` (la plantilla del elemento final), ej.: `<DialogTrigger render={<Button>Texto</Button>} />`. Confirmado que aplica a `DropdownMenuTrigger`, `Dialog`, `AlertDialog`, y probablemente a otros primitivos de este stack (`Sheet`, `Select`, `Popover`, etc.) si aparece un error similar.
- **`DropdownMenuLabel`/`DropdownMenuItem` deben ir dentro de `DropdownMenuGroup`** en esta versión — sin ese envoltorio, lanza `MenuGroupContext is missing`.
- **`ProtectedRoute`:** componente que revisa `token` del AuthContext y redirige con `<Navigate to="/login" replace />` si no existe. Ojo al probar: un token de una sesión anterior persiste en `localStorage` entre recargas — usar `localStorage.clear()` en la consola del navegador para probar el caso "sin sesión" de verdad.
- **`useQuery` vs `useMutation`:** `useQuery` se dispara automáticamente al montar el componente (para leer datos: dashboard, listados), `useMutation` se dispara manualmente con `.mutate()` (para crear/actualizar/eliminar: login, register, formularios). Cada `useQuery` necesita una `queryKey` única para el cache de React Query.
- **`inventory-value` es `stock × price` sumado, no solo la suma de precios** — con un solo producto de stock alto, el total puede parecer "raro" a primera vista si no se recuerda esa fórmula.
- **Register no devuelve token** (a diferencia de Login) — tras un registro exitoso, se redirige a `/login` para que el usuario inicie sesión con sus nuevas credenciales.
- **`queryClient.invalidateQueries({ queryKey: [...] })`**: tras cualquier `useMutation` que cree/edite/borre datos, hay que invalidar manualmente el/los `queryKey` afectados — React Query no detecta solo que los datos cambiaron. Un mismo mutation puede necesitar invalidar varias keys (ej. crear un movimiento afecta `["movements"]`, `["products"]` y `["reports"]` a la vez; recibir una orden de compra afecta `["purchase-orders"]` y `["products"]`).
- **Un solo Dialog para crear y editar**: se controla con un estado (`editingX = null` → creando; con objeto → editando), evitando duplicar el formulario. El `open` de `Dialog`/`AlertDialog` se maneja con `useState` propio cuando conviene, para evitar problemas de anidación de botones de Base UI si no se usa `render`.
- **Conversión de tipos de inputs**: los `<Input type="number">` de HTML siempre devuelven `string` — hay que convertir explícitamente con `Number(...)` antes de mandar al backend, o Zod rechaza la petición.
- **shadcn `Select` con Base UI requiere la prop `items`:** sin pasar `items={[{ value, label }, ...]}` directamente al componente `<Select>`, `SelectValue` muestra el `value` crudo (ej. un UUID) en vez del texto legible (`label`), aunque los `SelectItem` internos estén bien escritos. Es un requisito adicional de esta variante Base UI que no existía en la versión Radix clásica de shadcn.
- **`queryKey` con parámetros dinámicos** (ej. `["reports", "movements", from, to]`): incluir los filtros dentro de la key hace que React Query trate cada combinación de filtros como una consulta distinta y vuelva a pedir datos cuando cambian — si se omiten de la key, el cache no se refresca al cambiar el filtro.
- **Named exports obligatorios en páginas:** todas las páginas nuevas deben usar `export function NombrePagina()`, nunca `export default`, porque `AppRoutes.jsx` importa todas las páginas existentes como named exports (`import { Users } from "@/pages/Users"`). Mezclar los dos estilos produce `does not provide an export named 'X'`.
- **Router — evitar rutas duplicadas fuera y dentro de `Layout`:** se detectó que `users` estaba declarada dos veces en `AppRoutes.jsx` (una como ruta hermana en la raíz, sin `Layout` ni protección; otra dentro de `children`, sin `AdminRoute`). React Router matchea la de `children` primero, así que la de afuera queda muerta mientras además pierde la protección de rol. Regla a seguir: cada ruta protegida por rol va **una sola vez**, dentro de `children` (para heredar `Layout`), con el elemento envuelto en `AdminRoute` ahí mismo — patrón ya corregido y usado en `purchase-orders`.
- **Checklist al agregar una página nueva que llama a un endpoint nuevo:** confirmar en orden (1) que el router del backend está montado en `app.ts`, (2) que el backend se reinició tras montar el router (un `npm run dev` con watcher a veces no alcanza a levantar rutas nuevas sin reiniciar el proceso), antes de asumir que un 404 es un bug del frontend.

### Notas técnicas de Fase 1 y 2

- **Bug crítico de desincronización `JWT_SECRET` vs `JWT_SECRET_KEY`:** si el nombre de la variable de entorno usada para firmar (`Login`) no coincide exactamente con la usada para verificar (`Authenticated`), el token se firma con un valor (real o el de emergencia) y se verifica con otro — produce 401 persistentes con un token aparentemente válido y bien formado. Sospechar esto ante 401 que no se resuelven ni recreando el token. Solución: unificar el nombre exacto en ambos archivos, revisando primero cuál es el que realmente existe en `.env` (no asumir).
- **`Login` debe devolver `{ token, user }`, no solo el token** — si el controller solo reenvía lo que el service retorna (`res.json(result)`), hay que asegurarse de que el service arme ese objeto compuesto explícitamente (con `select` manual de los campos seguros del usuario, igual que en `Register`). Si el controller envuelve el resultado de nuevo en `{ token: result }`, se genera un objeto anidado y el frontend termina mandando `Authorization: Bearer [object Object]`.
- **Agregar un campo nuevo y obligatorio a un modelo (`isActive`, `avatarUrl`, etc.) rompe cualquier `select` de Prisma que prometa devolver el tipo completo** (ej. `Promise<ProfileData>` con `ProfileData = Omit<User, "passwordHash">`) si ese campo no se agrega también a los `select` existentes — TypeScript avisa con "Property 'X' is missing in type... but required in type 'ProfileData'".
- **Revocación de sesión al desactivar un usuario:** como el JWT no tiene estado en el servidor, desactivar a alguien no invalida sus tokens ya emitidos por sí solo. Hace falta que el middleware `Authenticated` consulte la BD en cada petición (`prisma.user.findUnique` + chequeo de `isActive`) para que la desactivación tenga efecto inmediato, en vez de esperar a que el token expire.
- **i18next (react-i18next):** estructura de claves anidadas en JSON por idioma (`es.json`/`en.json`), cargados en `i18n/index.js` con `lng` inicial leído de `localStorage`. En cada componente: `const { t } = useTranslation()` y reemplazar texto fijo por `t("clave.anidada")`. `i18n.changeLanguage(value)` cambia el idioma en caliente en toda la app sin recargar. Reusar claves compartidas (ej. "Email"/"Password") entre formularios distintos en vez de duplicarlas.
- **Modo oscuro/claro con Context propio:** a diferencia de `AuthContext` (que no necesita `useEffect` porque lee `localStorage` de forma perezosa), el `ThemeContext` sí usa un `useEffect` legítimo — porque su propósito es sincronizar el estado de React con un sistema externo real (la clase `dark`/`light` en el `<html>` del DOM), que es el caso de uso que React sí recomienda para efectos.
- **Patrón para inicializar un formulario con datos que llegan async (evitando el warning de `setState` en efecto):** extraer el formulario a un componente hijo separado que recibe los datos ya cargados como prop, y solo montarlo condicionalmente (`{data && <Form data={data} />}`). El `useState(data.campo)` del hijo se ejecuta una sola vez, con datos reales, sin necesitar ningún `useEffect` de sincronización.
- **Gestión de usuarios — regla de "no auto-desactivación":** se implementa comparando `targetUserId === requestingUserId` en el service, no por rol — un admin puede desactivar a otro admin, solo no puede desactivarse a sí mismo. En el frontend, un `AdminRoute` (similar a `ProtectedRoute` pero validando `user.role === "ADMIN"`) evita que un empleado llegue a la pantalla de gestión por URL directa, aunque la protección real sigue siendo el `Authorize("ADMIN")` del backend.

---

## 8. Cómo seguimos trabajando (metodología)

Para cada nueva funcionalidad:
1. Se explica el concepto/flujo antes de tocar código.
2. Se identifican los pasos en texto plano (en español, sin sintaxis) antes de programar.
3. Se escribe primero el **Service** (lógica pura), después el **Controller**, después las **Routes**.
4. Se dan pistas de qué método/función se necesita (sin el código completo) para que el usuario lo escriba.
5. Se revisa lo escrito, se corrige, y se explica el porqué de cada corrección.
6. Se prueba el flujo completo antes de pasar al siguiente módulo.

Objetivo: que el usuario entienda cada pieza para depender cada vez menos de la IA a futuro.

---

## 9. Próximas fases (resumen para retomar rápido)

**Fase 6 — Refresh tokens, soft delete, auditoría** (no iniciada):
- Refresh tokens: token de acceso corto (15min) + refresh de larga vida (7 días) en tabla nueva (`RefreshToken`: `userId`, token hasheado, `expiresAt`, `revoked`), endpoint `POST /auth/refresh`, interceptor de axios que detecte 401 y reintente antes de deslogear.
- Soft delete: `deletedAt DateTime?` en `Product`/`Category`, usar `.update({ deletedAt: new Date() })` en vez de `.delete()`, filtrar `where: { deletedAt: null }` en todos los `findMany`/`findUnique` existentes — protege el historial de `StockMovement`/`PurchaseOrderItem`/`PurchaseRequest` que referencian productos.
- Auditoría: tabla `AuditLog` (`userId`, `action`, `entityType`, `entityId`, `changes` Json?, `createdAt`), registrar en los services de update/delete de los módulos principales, página `AuditLog.jsx` (solo ADMIN) con tabla filtrable.
- Considerar acá también: agregar cobertura de tests para `purchase-requests`/`purchase-orders`, y los schemas/paths faltantes en `openapi.yaml`.

**Fase 7 — Asistente IA (modo solo lectura)** (no iniciada):
- Endpoint `POST /assistant/chat`: recibe el mensaje, llama a la API de Claude con tool use, ejecuta las tools que el modelo pida (`getProducts`, `getLowStockReport`, `getMovements`, etc. — funciones que consultan datos reales, nunca inventadas), devuelve la respuesta final.
- Frontend: widget de chat flotante o página dedicada — sin decisiones de UI tomadas todavía.
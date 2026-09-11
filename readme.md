# Inventario API

Sistema de gestión de inventario para una pequeña empresa. Backend REST con autenticación por roles, CRUD de productos/categorías, control de stock con trazabilidad, y reportes.

## Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **Framework:** Express
- **Base de datos:** PostgreSQL (vía Docker)
- **ORM:** Prisma (con driver adapters, generador `prisma-client`)
- **Auth:** JWT + bcrypt
- **Ejecutor de desarrollo:** `tsx`

## Requisitos previos

- Node.js (LTS)
- Docker y Docker Compose

## Instalación y arranque

1. Clonar el repositorio e instalar dependencias:
   ```bash
   npm install
   ```

2. Crear el archivo `.env` en la raíz con las siguientes variables:
   ```
   PORT=3000
   DATABASE_URL=postgresql://usuario:contraseña@localhost:5432/inventario_db
   JWT_SECRET=algo_largo_y_random
   ADMIN_INITIAL_PASSWORD=clave_temporal_segura
   ```

3. Levantar la base de datos (Postgres en Docker):
   ```bash
   docker-compose up -d
   ```

4. Aplicar las migraciones de la base de datos:
   ```bash
   npx prisma migrate dev
   ```

5. Generar el usuario administrador inicial (idempotente, seguro de correr varias veces):
   ```bash
   npx prisma db seed
   ```

6. Levantar el servidor en modo desarrollo:
   ```bash
   npm run dev
   ```

El servidor queda disponible en `http://localhost:3000`. Puedes verificar que está corriendo con `GET /health`.

### Otros comandos útiles

```bash
npx prisma studio     # Interfaz visual para ver/editar los datos
npm run build          # Compila TypeScript a JavaScript (dist/)
npm run start           # Corre la versión compilada (producción)
```

## Arquitectura

El proyecto sigue una arquitectura en capas, organizada por módulo de dominio:

```
Request → Router → Middleware (auth/roles) → Controller → Service → Prisma → DB
```

- **Router**: define las rutas HTTP y qué middlewares/controller les corresponde.
- **Controller**: recibe `req`/`res`, extrae datos, llama al Service, decide la respuesta HTTP.
- **Service**: lógica de negocio real, habla con Prisma. No conoce `req`/`res`.
- **Middlewares**: `Authenticated` (verifica JWT) y `Authorize(...roles)` (verifica rol del usuario).

## Estructura de carpetas

```
inventario-api/
├── src/
│   ├── config/
│   │   └── database.ts          # Instancia única de Prisma Client (con driver adapter)
│   ├── middlewares/
│   │   └── authenticate.middleware.ts  # Authenticated y Authorize
│   ├── types/
│   │   └── express.d.ts         # Extensión de Request con req.user
│   ├── modules/
│   │   ├── auth/                # register, login, /me
│   │   ├── categories/          # CRUD de categorías
│   │   ├── products/            # CRUD de productos
│   │   ├── movements/           # Registro y consulta de movimientos de stock
│   │   └── reports/             # Reportes (en construcción)
│   ├── generated/prisma/        # Cliente de Prisma autogenerado (no se edita a mano)
│   ├── app.ts                   # Configuración de Express y montaje de routers
│   └── server.ts                # Punto de entrada, carga env y levanta el servidor
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts                  # Script para crear el admin inicial
│   └── migrations/
├── prisma.config.ts              # Configuración de la CLI de Prisma (datasource, seed)
├── docker-compose.yml
└── .env
```

## Modelo de datos

- **User**: usuarios del sistema, con rol `ADMIN` o `EMPLOYEE`.
- **Category**: categorías de productos.
- **Product**: productos del inventario. El `stock` no se edita directamente vía CRUD — cambia únicamente a través de movimientos.
- **StockMovement**: bitácora de entradas (`IN`), salidas (`OUT`) y ajustes (`ADJUSTMENT`) de stock, asociada al producto y al usuario que la registró.

## Roles y permisos

| Acción | ADMIN | EMPLOYEE |
|---|---|---|
| Ver categorías / productos / movimientos | ✅ | ✅ |
| Crear / editar / eliminar categorías o productos | ✅ | ❌ |
| Registrar movimientos de stock | ✅ | ✅ |

El primer usuario `ADMIN` se crea únicamente vía el script de seed (`npx prisma db seed`), nunca por registro público. El registro público (`POST /auth/register`) siempre crea usuarios con rol `EMPLOYEE`.

## Endpoints

Todas las rutas protegidas requieren el header:
```
Authorization: Bearer <token>
```

### Auth (`/auth`)

| Método | Ruta | Protección | Descripción |
|---|---|---|---|
| POST | `/auth/register` | Pública | Crea un usuario con rol `EMPLOYEE` |
| POST | `/auth/login` | Pública | Devuelve un JWT si las credenciales son válidas |
| GET | `/auth/me` | Autenticado | Devuelve los datos del usuario del token |

### Categorías (`/categories`)

| Método | Ruta | Protección |
|---|---|---|
| GET | `/categories/` | Autenticado |
| GET | `/categories/:id` | Autenticado |
| POST | `/categories/` | Autenticado + ADMIN |
| PUT | `/categories/:id` | Autenticado + ADMIN |
| DELETE | `/categories/:id` | Autenticado + ADMIN |

### Productos (`/products`)

| Método | Ruta | Protección |
|---|---|---|
| GET | `/products/` | Autenticado |
| GET | `/products/:id` | Autenticado |
| POST | `/products/` | Autenticado + ADMIN |
| PUT | `/products/:id` | Autenticado + ADMIN (no permite editar `stock`) |
| DELETE | `/products/:id` | Autenticado + ADMIN |

### Movimientos de stock (`/movements`)

| Método | Ruta | Protección | Descripción |
|---|---|---|---|
| POST | `/movements/` | Autenticado + (ADMIN o EMPLOYEE) | Registra un movimiento y actualiza el stock del producto en una transacción |
| GET | `/movements/` | Autenticado | Lista movimientos. Acepta `?productId=` opcional para filtrar |

**Reglas de `POST /movements/`:**
- `type: "IN"` → `quantity` se suma al stock actual.
- `type: "OUT"` → `quantity` se resta; se rechaza si el resultado quedaría negativo.
- `type: "ADJUSTMENT"` → `quantity` reemplaza el stock actual (valor final tras un conteo físico).

### Reportes (`/reports`)

| Método | Ruta | Protección | Descripción |
|---|---|---|---|
| GET | `/reports/low-stock` | Autenticado | Productos con `stock <= minStock` |
| GET | `/reports/movements?from=&to=` | Autenticado | Movimientos filtrados por rango de fechas (ambos parámetros opcionales) |
| GET | `/reports/inventory-value` | Autenticado | Valor total del inventario (`Σ stock × price`) y cantidad de productos |

## Documentación interactiva (Swagger)

Con el servidor corriendo, la documentación completa de la API está disponible en:
```
http://localhost:3000/api-docs
```

Incluye todos los endpoints agrupados por módulo, con sus schemas de request/response, y un botón **Authorize** para pegar un JWT y probar las rutas protegidas directamente desde el navegador.

El documento fuente vive en `openapi.yaml`, en la raíz del proyecto.

## Frontend

Existe un frontend independiente (React + Vite) en la carpeta `inventario-frontend/`, al mismo nivel que este proyecto. Ver su propio README para instrucciones de instalación. Requiere que este backend esté corriendo en `http://localhost:3000` con CORS habilitado para `http://localhost:5173`.

## Pendientes

- Deploy
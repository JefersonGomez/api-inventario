# Despliegue de Stockly

Todo corre en contenedores de Docker en una sola máquina:

| Servicio | Qué es | Imagen |
|---|---|---|
| `db` | PostgreSQL 16; los datos viven en el volumen `db_data` | `postgres:16` |
| `api` | Backend (Node + Express); al arrancar aplica las migraciones | `inventario-api/Dockerfile` |
| `web` | Frontend compilado, servido por nginx | `inventario-frontend/Dockerfile` |
| `caddy` | Puerta de entrada: HTTPS automático, `/api/*` → api, lo demás → web | `caddy:2` |

Solo Caddy publica puertos (80 y 443). La base y la API no se ven desde afuera.

## Probarlo en tu computadora

```bash
# 1. construir las imágenes (desde la carpeta de cada repo)
cd inventario-api && docker build -t stockly-api:local .
cd ../APIInventarioFrotend/inventario-frontend && docker build -t stockly-web:local .

# 2. variables: copiar el ejemplo y llenar POSTGRES_PASSWORD y JWT_SECRET_KEY
cd ../../inventario-api/deploy && cp .env.example .env

# 3. levantar todo y ver los registros
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api

# 4. crear el primer administrador (pide la contraseña por variable, no queda en el historial de la base)
docker compose -f docker-compose.prod.yml exec -e ADMIN_INITIAL_PASSWORD='...' api npx prisma db seed
```

Abrir `http://localhost` (o `http://localhost:8080` si pusiste `HTTP_PORT=8080`).

Para apagar: `docker compose -f docker-compose.prod.yml down` (los datos quedan en los volúmenes;
`down -v` los borra).

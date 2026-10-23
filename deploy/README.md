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

## En la VPS: respaldo diario y demo pública

El despliegue automático copia `backup.sh` a `/opt/stockly`. En el crontab del usuario `deploy` (`crontab -e`),
con la VPS en hora UTC (Costa Rica = UTC−6, así que 9:00 UTC son las 3:00 a. m.):

```cron
# 3:00 a. m. CR: respaldo de la base (se guardan 7 días)
0 9 * * * /opt/stockly/backup.sh >> /opt/stockly/backup.log 2>&1
# 3:15 a. m. CR: la demo vuelve a empezar (solo con DEMO_ENABLED=1 en .env)
15 9 * * * cd /opt/stockly && docker compose -f docker-compose.prod.yml exec -T api npm run demo:reset >> /opt/stockly/demo-reset.log 2>&1
```

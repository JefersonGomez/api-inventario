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

## En la VPS: facturación electrónica

Todo desde `/opt/stockly` con el usuario `deploy` (o root). Las migraciones se aplican solas al arrancar la API.

```bash
cd /opt/stockly
cp .env .env.respaldo-$(date +%Y%m%d)                       # respaldo antes de tocarlo
sed -i '/^EINVOICE_SECRET=$/d' .env                           # quita una línea vacía si existiera
grep -q '^EINVOICE_SECRET=.\{32,\}' .env \
  || echo "EINVOICE_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" >> .env
docker compose -f docker-compose.prod.yml up -d --force-recreate api
```

- `EINVOICE_SECRET` cifra en la base las credenciales y la llave .p12 de cada empresa. **No cambiarla nunca**
  (lo guardado ya no se podría leer) y guardar una copia fuera del servidor (gestor de contraseñas).
- Cada empresa carga su usuario, clave, llave .p12 y PIN de **producción** en la app:
  Configuración → Facturación electrónica (no van en el .env).
- Correo de facturas a los clientes: hace falta `EMAIL_FROM` con un dominio verificado en Resend; sin eso todo
  llega a `EMAIL_TEST_TO`.
- Empresas sin sucursal (creadas por el seed viejo) no pueden crear productos ni vender. Revisar y arreglar:

```bash
docker compose -f docker-compose.prod.yml exec -T db psql -U stockly -d stockly -c \
  'select c.name, count(l.id) as sucursales from "Company" c left join "Location" l on l."companyId" = c.id group by c.name;'
# si alguna tiene 0:
docker compose -f docker-compose.prod.yml exec -T db psql -U stockly -d stockly -c \
  "insert into \"Location\" (id, \"companyId\", name, type, code, \"updatedAt\") select gen_random_uuid()::text, c.id, 'Sucursal principal', 'BRANCH', '001', now() from \"Company\" c where not exists (select 1 from \"Location\" l where l.\"companyId\" = c.id);"
```

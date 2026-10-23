#!/bin/sh
# Respaldo diario de la base de Stockly: una copia comprimida por día en ./backups, se guardan 7 días.
# Lo corre el cron de la VPS (ver README.md). Restaurar:
#   gunzip -c backups/stockly_AAAA-MM-DD.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U stockly stockly
set -e
cd "$(dirname "$0")"
mkdir -p backups
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U stockly stockly | gzip > "backups/stockly_$(date +%F).sql.gz"
find backups -name 'stockly_*.sql.gz' -mtime +7 -delete
echo "$(date '+%F %T') respaldo listo: $(ls -1 backups | wc -l) archivo(s)"

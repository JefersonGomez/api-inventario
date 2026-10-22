# Imagen de la API de Stockly. Se construye en GitHub Actions y la VPS solo la descarga.
# Debian slim (no Alpine): bcrypt trae binarios ya compilados para glibc.
FROM node:22-slim

WORKDIR /app
# OpenSSL: lo usa el motor de Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# primero las dependencias: si package*.json no cambia, Docker reutiliza esta capa y el build es rápido.
# --omit=dev: sin jest, TypeScript ni lo demás de desarrollo (la imagen pesa mucho menos)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json openapi.yaml ./
COPY src ./src
COPY scripts ./scripts
# el cliente de Prisma se genera dentro de la imagen (src/generated no está en Git)
# el código queda de root (solo lectura para la app); la única carpeta donde se escribe es uploads
RUN npx prisma generate && mkdir -p uploads/avatars && chown -R node:node uploads

ENV NODE_ENV=production
EXPOSE 3000
# corre como el usuario "node" (sin privilegios), no como root
USER node

# al arrancar: aplica las migraciones pendientes y levanta el servidor
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]

# Build both release images on the VPS, from the repository root.
# Targets: frontend, backend. No environment files or databases enter an image.
FROM node:22-bookworm-slim AS frontend_build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend_dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS backend
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=backend_dependencies --chown=node:node /build/backend/node_modules ./node_modules
COPY --chown=node:node backend/package.json backend/package-lock.json ./
COPY --chown=node:node backend/*.js ./
COPY --chown=node:node backend/db/ ./db/
COPY --chown=node:node backend/scripts/ ./scripts/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
CMD ["node", "server.js"]

FROM nginx:stable-alpine AS frontend
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend_build /build/frontend/dist/ /usr/share/nginx/html/
EXPOSE 80

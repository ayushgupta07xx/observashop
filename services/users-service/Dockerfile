# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first so dependency install is cached separately from source changes
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies to shrink the node_modules we carry forward
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as a non-root user (the node:alpine image ships with a 'node' user, uid 1000)
USER node

# Copy only what's needed to run
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck so Docker/Kubernetes know if the container is broken
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]

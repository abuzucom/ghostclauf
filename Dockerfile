# ── Build stage: compile TypeScript ──────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage: slim production image ─────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /data holds the token store (and optional drop-in plugins); owned by `node`.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
CMD ["node", "dist/index.js"]

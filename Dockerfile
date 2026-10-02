# ── Build stage: compile TypeScript ──────────────────────────────────────────
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage: slim production image ─────────────────────────────────────
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /data holds the token store (and optional drop-in plugins); owned by `node`.
RUN mkdir -p /data && chown -R node:node /data /app
# Numeric uid:gid of the image's `node` user; hadolint DL3066 flags names the host may not resolve.
USER 1000:1000
VOLUME ["/data"]
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1.7
# Search Hub production image.
# - deps: full workspace install (build tooling included)
# - build: web bundle + server bundle
# - prod-deps: production-only node_modules
# - runtime: node:22-bookworm-slim, non-root, SQLite on a volume
#
# The runtime does NOT run TypeScript directly: apps/api/dist/server.mjs and
# packages/mcp/dist/stdio.mjs are produced by scripts/build-server.mjs.

# Pin the base image by version tag, or by digest for fully reproducible builds:
#   docker build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:<digest> .
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack asks for confirmation before downloading a package manager; there is
# no TTY during a build, so disable the prompt explicitly.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------- dependencies (build) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    corepack pnpm install --frozen-lockfile

# ---------- build web + server bundles ----------
FROM deps AS build
COPY . .
RUN corepack pnpm build

# ---------- production dependencies ----------
# Installed from scratch instead of pruning `deps`: this does not depend on
# pnpm's prune semantics and guarantees no dev-only package (vite, esbuild,
# TypeScript) reaches the runtime layer.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    corepack pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production
ENV SEARCH_HUB_DATA_DIR=/app/data
ENV SEARCH_HUB_HOST=0.0.0.0
ENV SEARCH_HUB_PORT=8787
ENV SEARCH_HUB_STATIC_DIR=/app/apps/web/dist
ENV SEARCH_HUB_MIGRATIONS_DIR=/app/apps/api/migrations

RUN groupadd --system --gid 1001 searchhub \
    && useradd --system --uid 1001 --gid searchhub --home-dir /app searchhub

# --chown on every COPY keeps the image small: a separate `chown -R` would copy
# every file again into a new layer. Only the data directory needs to be
# writable at runtime; everything else is read-only for uid 1001.
COPY --chown=searchhub:searchhub --from=prod-deps /app/node_modules ./node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/models/node_modules ./packages/models/node_modules
COPY --chown=searchhub:searchhub --from=prod-deps /app/packages/mcp/node_modules ./packages/mcp/node_modules

COPY --chown=searchhub:searchhub --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=searchhub:searchhub --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --chown=searchhub:searchhub --from=build /app/packages/mcp/dist ./packages/mcp/dist
COPY --chown=searchhub:searchhub --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=searchhub:searchhub --from=build /app/packages/skills ./packages/skills
COPY --chown=searchhub:searchhub package.json ./

RUN mkdir -p /app/data && chown searchhub:searchhub /app/data

USER searchhub
WORKDIR /app
EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.mjs"]

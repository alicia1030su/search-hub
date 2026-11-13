# syntax=docker/dockerfile:1.7
# Search Hub production image.
# - builder: full workspace install + web build
# - deps: production-only node_modules (workspace links preserved)
# - runtime: node:22-bookworm-slim, non-root, SQLite on a mounted volume

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
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

# ---------- build the web bundle ----------
FROM deps AS build
COPY . .
RUN corepack pnpm --filter @search-hub/web build

# ---------- production dependencies ----------
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    corepack pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production
ENV SEARCH_HUB_DATA_DIR=/app/data
ENV SEARCH_HUB_HOST=0.0.0.0
ENV SEARCH_HUB_PORT=8787

RUN groupadd --system --gid 1001 searchhub \
    && useradd --system --uid 1001 --gid searchhub --home-dir /app searchhub

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY --from=prod-deps /app/packages/models/node_modules ./packages/models/node_modules
COPY --from=prod-deps /app/packages/mcp/node_modules ./packages/mcp/node_modules

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY apps/web/dist ./apps/web/dist
COPY packages ./packages
COPY docs ./docs
COPY README.md README_EN.md LICENSE CHANGELOG.md SECURITY.md CONTRIBUTING.md ./

RUN mkdir -p /app/data && chown -R searchhub:searchhub /app/data /app/apps /app/packages

USER searchhub
WORKDIR /app/apps/api
EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]

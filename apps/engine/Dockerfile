# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Engine container — NestJS trading bot.
# Multi-stage: builder compiles `@bot/shared` + `@bot/engine`; runtime ships
# only the compiled dist + production deps.
#
# 24/7 service: runs as PID 1 with `--init` (compose flag) for proper signal
# handling, non-root user, healthcheck on /v1/health.
# ---------------------------------------------------------------------------

ARG NODE_IMAGE=node:22.20-alpine
ARG PNPM_VERSION=9.15.9


# =====================================================================
# Stage 1 — builder
# =====================================================================
FROM ${NODE_IMAGE} AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Copy workspace manifests first — keeps the install layer cacheable on
# pure source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/engine/package.json ./apps/engine/
COPY apps/dashboard/package.json ./apps/dashboard/

# Install ALL workspace deps (engine + shared + dashboard) so pnpm wires the
# workspace symlinks. The runtime stage only copies the engine/shared trees.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now copy sources and build.
COPY packages/shared ./packages/shared
COPY apps/engine ./apps/engine

RUN pnpm --filter @bot/shared build \
 && pnpm --filter @bot/engine build


# =====================================================================
# Stage 2 — production deps only (slimmer copy into runtime)
# =====================================================================
FROM ${NODE_IMAGE} AS prod-deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/engine/package.json ./apps/engine/
COPY apps/dashboard/package.json ./apps/dashboard/

# Prod-only install across the workspace; runtime stage copies what it needs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod


# =====================================================================
# Stage 3 — runtime (minimal)
# =====================================================================
FROM ${NODE_IMAGE} AS runtime

# NODE_ENV is left for compose `environment:` to set — the image supports
# both development (pino-pretty logging) and production (json logging) runtimes.

# wget for the container HEALTHCHECK; tini is provided via compose `init: true`.
# pino-pretty is intentionally installed here so pino can resolve the transport
# when NODE_ENV != production (it is a dev-time logging convenience, not an app dep).
RUN apk add --no-cache wget

# Non-root user (alpine `node` image ships a `node` user uid 1000).
WORKDIR /app

# Built engine + the resolved production node_modules.
COPY --from=builder    --chown=node:node /repo/apps/engine/dist                  ./apps/engine/dist
COPY --from=builder    --chown=node:node /repo/apps/engine/package.json          ./apps/engine/package.json
COPY --from=builder    --chown=node:node /repo/packages/shared/dist              ./packages/shared/dist
COPY --from=builder    --chown=node:node /repo/packages/shared/package.json      ./packages/shared/package.json
COPY --from=prod-deps  --chown=node:node /repo/node_modules                      ./node_modules
COPY --from=prod-deps  --chown=node:node /repo/apps/engine/node_modules          ./apps/engine/node_modules
COPY --from=prod-deps  --chown=node:node /repo/packages/shared/node_modules      ./packages/shared/node_modules

# R2 security M4 — pino-pretty install is gated behind a build arg so prod /
# CI images are reproducible and contain no dev-only network fetches.
# Local dev (compose) sets INCLUDE_DEV_LOGS=true so NODE_ENV=development
# logs render via pino-pretty. Default = false (safe for prod).
ARG INCLUDE_DEV_LOGS=false
RUN if [ "$INCLUDE_DEV_LOGS" = "true" ]; then \
        npm install --no-audit --no-fund --no-save --prefix /app pino-pretty@13.1.3 \
     && chown -R node:node /app/node_modules; \
    fi

USER node

WORKDIR /app/apps/engine

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD wget -qO- "http://127.0.0.1:${ENGINE_PORT:-3000}/v1/health" >/dev/null 2>&1 || exit 1

# No `npm start` — exec node directly so it inherits PID 1 signals.
CMD ["node", "dist/main.js"]

# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# MCP server container — read-only analytical surface for the agent (ADR 0033,
# ADR 0034, ADR 0038). Multi-stage: builder compiles `@bot/shared` +
# `@bot/analysis` + `@bot/mcp`; runtime ships only the compiled dist + the
# production deps.
#
# Long-running service: serves the HTTP JSON-RPC transport on a private compose
# network. NEVER published to the host — the agent reaches it via service-DNS.
# Compose `restart: unless-stopped`. Healthcheck hits the unauthenticated
# `/healthz` endpoint over loopback INSIDE the container.
#
# Boundary invariant (ADR 0033 §2.3 layer A): @bot/engine source is NEVER
# copied into this image. The workspace package.json files are needed so pnpm
# can resolve the workspace topology, but engine/dashboard/agent source trees
# are deliberately absent.
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

# Workspace manifests first — keeps the install layer cacheable on pure
# source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/analysis/package.json ./packages/analysis/
COPY apps/engine/package.json       ./apps/engine/
COPY apps/dashboard/package.json    ./apps/dashboard/
COPY apps/mcp/package.json          ./apps/mcp/
COPY apps/agent/package.json        ./apps/agent/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source trees: ONLY shared + analysis + mcp. Engine/agent/dashboard are
# never copied — defense-in-depth against a boundary leak via misconfigured
# volume or COPY.
COPY packages/shared   ./packages/shared
COPY packages/analysis ./packages/analysis
COPY apps/mcp          ./apps/mcp

RUN pnpm --filter @bot/shared build \
 && pnpm --filter @bot/analysis build \
 && pnpm --filter @bot/mcp build


# =====================================================================
# Stage 2 — production deps only
# =====================================================================
FROM ${NODE_IMAGE} AS prod-deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/analysis/package.json ./packages/analysis/
COPY apps/engine/package.json       ./apps/engine/
COPY apps/dashboard/package.json    ./apps/dashboard/
COPY apps/mcp/package.json          ./apps/mcp/
COPY apps/agent/package.json        ./apps/agent/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod


# =====================================================================
# Stage 3 — runtime (minimal)
# =====================================================================
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

# Built mcp + analysis + shared + the resolved production node_modules.
# Engine, dashboard, agent trees deliberately absent (ADR 0033 §2.3).
COPY --from=builder    --chown=node:node /repo/apps/mcp/dist                    ./apps/mcp/dist
COPY --from=builder    --chown=node:node /repo/apps/mcp/package.json            ./apps/mcp/package.json
COPY --from=builder    --chown=node:node /repo/packages/shared/dist             ./packages/shared/dist
COPY --from=builder    --chown=node:node /repo/packages/shared/package.json     ./packages/shared/package.json
COPY --from=builder    --chown=node:node /repo/packages/analysis/dist           ./packages/analysis/dist
COPY --from=builder    --chown=node:node /repo/packages/analysis/package.json   ./packages/analysis/package.json
COPY --from=prod-deps  --chown=node:node /repo/node_modules                     ./node_modules
COPY --from=prod-deps  --chown=node:node /repo/apps/mcp/node_modules            ./apps/mcp/node_modules
COPY --from=prod-deps  --chown=node:node /repo/packages/shared/node_modules     ./packages/shared/node_modules
COPY --from=prod-deps  --chown=node:node /repo/packages/analysis/node_modules   ./packages/analysis/node_modules

USER node

WORKDIR /app/apps/mcp

# Probe the unauthenticated /healthz the HTTP transport exposes. Uses wget
# (already in node:alpine via busybox) over IPv4 loopback INSIDE the container.
# The transport itself binds to MCP_HTTP_BIND_HOST (default 127.0.0.1; set to
# 0.0.0.0 on the compose network); 127.0.0.1 inside the container reaches the
# listener in either case.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=15s \
    CMD wget -qO- http://127.0.0.1:${MCP_HTTP_PORT:-5434}/healthz >/dev/null 2>&1 || exit 1

# main.ts installs SIGINT/SIGTERM handlers for clean shutdown; default
# STOPSIGNAL is SIGTERM which is what we want.
CMD ["node", "dist/main.js"]

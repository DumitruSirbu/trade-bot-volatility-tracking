# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Agent container — weekly outer-loop process (ADR 0035).
# Multi-stage: builder compiles `@bot/shared` + `@bot/agent`; runtime ships
# only the compiled dist + production deps.
#
# Batch job, NOT a 24/7 service: launched on-demand (compose `--profile
# agent run`), exits when the loop completes. Compose `restart: 'no'`.
# Healthcheck stub here — real check lands in M13 W5 once the loop body
# exists and the lockfile owner is known.
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
# source edits. The agent's workspace-dep graph deliberately excludes
# @bot/engine, @bot/analysis, @bot/mcp (ADR 0035 §2.3 layer A); we still
# need their package.json copies for pnpm to resolve the workspace
# topology, but we never copy their source trees into this image.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/engine/package.json ./apps/engine/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/agent/package.json ./apps/agent/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source trees: ONLY shared + agent. Engine/mcp/dashboard/analysis are
# never copied — defense-in-depth against accidental boundary leak via a
# misconfigured volume or COPY.
COPY packages/shared ./packages/shared
COPY apps/agent ./apps/agent

RUN pnpm --filter @bot/shared build \
 && pnpm --filter @bot/agent build


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
COPY packages/shared/package.json ./packages/shared/
COPY apps/engine/package.json ./apps/engine/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/agent/package.json ./apps/agent/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod


# =====================================================================
# Stage 3 — runtime (minimal)
# =====================================================================
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

# Built agent + shared + the resolved production node_modules. Engine,
# MCP, dashboard, analysis trees deliberately absent (ADR 0035 §2.3).
COPY --from=builder    --chown=node:node /repo/apps/agent/dist               ./apps/agent/dist
COPY --from=builder    --chown=node:node /repo/apps/agent/package.json       ./apps/agent/package.json
COPY --from=builder    --chown=node:node /repo/packages/shared/dist          ./packages/shared/dist
COPY --from=builder    --chown=node:node /repo/packages/shared/package.json  ./packages/shared/package.json
COPY --from=prod-deps  --chown=node:node /repo/node_modules                  ./node_modules
COPY --from=prod-deps  --chown=node:node /repo/apps/agent/node_modules       ./apps/agent/node_modules
COPY --from=prod-deps  --chown=node:node /repo/packages/shared/node_modules  ./packages/shared/node_modules

# Report output directory (compose mounts ./reports/agent here).
RUN mkdir -p /app/reports && chown -R node:node /app/reports

USER node

WORKDIR /app/apps/agent

# Healthcheck stub — the agent is a batch job, not a long-running
# server. M13 W5 replaces this with a real liveness probe (lockfile +
# last-run-status read) once the loop body is wired.
HEALTHCHECK NONE

CMD ["node", "dist/main.js"]

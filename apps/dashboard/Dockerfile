# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Dashboard container — static SPA served by nginx (unprivileged).
# Builder compiles `@bot/shared` + Vite production bundle; runtime is
# nginx:alpine-slim-unprivileged binding port 8080 as a non-root user.
# ---------------------------------------------------------------------------

ARG NODE_IMAGE=node:22.20-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine
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

# Workspace manifests first for cached installs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/engine/package.json ./apps/engine/

# Install ALL workspace deps so pnpm wires `@bot/shared` symlinks deterministically.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/dashboard ./apps/dashboard

RUN pnpm --filter @bot/shared build \
 && pnpm --filter @bot/dashboard build


# =====================================================================
# Stage 2 — runtime (nginx-unprivileged, runs as uid 101)
# =====================================================================
FROM ${NGINX_IMAGE} AS runtime

# Replace the default site config with the same-origin reverse-proxy config.
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Static bundle.
COPY --from=builder /repo/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

# Image default CMD ["nginx", "-g", "daemon off;"] is correct — no override.

# ADR 0026 — Dashboard architecture & topology (M10)

**Status:** Accepted (M10 design wave)
**Date:** 2026-05-25
**Milestone:** M10 — Dashboard
**Depends on:** ADR 0020 (auth/CORS), ADR 0021 (kill-switch), ADR 0022 (read API), ADR 0023 (WS gateway), ADR 0027 (login endpoint).
**Consumed by:** M11 (go-live hardening — HTTPS/edge proxy).

## 1. Context

M9 closed with a complete read API (`/v1/*`), socket.io `/live` gateway, HS256 bearer auth, CORS allow-list, kill-switch endpoint with audit + rate-limit, and a Telegram alert pipeline. The engine is observable. The dashboard does not yet exist — `apps/dashboard/` is empty, `docker-compose.yml` has only postgres + adminer, and the engine has no `Dockerfile`. M10's brief is to ship the read-only React UI, the kill-switch button, and a containerised topology that mirrors what M11 will harden for go-live.

The architectural questions M10 must lock before W1 dispatches:

1. **Build vs serve split.** Vite dev server is the developer's loop; what serves the production bundle?
2. **How does the browser reach the engine?** Direct CORS to `:3000` vs same-origin reverse-proxy.
3. **Where does the operator get their token?** ADR 0020 picked CLI-issued JWTs; the dashboard must make that workable.
4. **Container topology.** Service names, depends_on, healthchecks, env wiring.
5. **Kill-switch UX contract.** The button's confirm flow defends against the most expensive mis-click in the system.

Decisions here lock the dashboard's external shape; component-internal decomposition stays a dashboard-agent concern.

## 2. Decision

### 2.1 Build pipeline: Vite dev server in dev, nginx-served static bundle in prod

The dashboard is a pure SPA: a static `dist/` from `vite build`, served by `nginx:alpine` in production. No SSR, no Next.js, no Node runtime in the dashboard container. Rationale:

- Bundle is small (a single-operator dashboard with shadcn primitives), so SSR offers no perceived-perf win.
- nginx is operationally well-understood, hardened by default, and ships gzip + cache-control + reverse-proxy in one config.
- Build-and-serve separation matches the M11 go-live target (the same bundle can be uploaded to a CDN later without re-architecture).

Dev loop stays on `vite dev` (port 5173, HMR). Production loop is `docker compose up dashboard` → nginx :80 → host :8080.

### 2.2 Same-origin reverse-proxy (dev and prod)

The browser **always** hits the same origin as the dashboard for both REST and WS. nginx (prod) and the Vite dev proxy (dev) forward `/v1/*` and `/socket.io/*` to the engine.

```
Dev:
  Browser ──▶ http://localhost:5173  (vite)
                  │  /v1/*      proxy_pass http://localhost:3000
                  │  /socket.io/* proxy_pass http://localhost:3000 (ws upgrade)
                  ▼
            Engine (pnpm engine:dev) :3000

Prod (docker compose):
  Browser ──▶ http://localhost:8080  (dashboard:nginx)
                  │  /v1/*      proxy_pass http://engine:3000
                  │  /socket.io/* proxy_pass http://engine:3000 (ws upgrade)
                  ▼
            engine service :3000 on the compose network
```

Same-origin design reasons:

- **CORS surface shrinks.** The dashboard's outbound URL is always the same host as the SPA — most preflights vanish, simplifying the engine's allow-list to just the dashboard origin (M11 will narrow further).
- **One TLS cert.** When M11 adds HTTPS, only the dashboard origin needs a cert; the engine stays plain HTTP on the private network.
- **Network-secret hiding.** The browser never learns the engine's hostname/port — engine is reachable only through the dashboard's reverse-proxy or the operator's CLI/curl from the host. Reduces blast radius if the dashboard origin is ever inadvertently exposed.

The dashboard code does **not** know the engine URL. `apiClient` issues relative paths (`/v1/health`). The socket.io-client connects with `io({ path: '/socket.io' })` (default), no `url` argument — picks up the current origin.

### 2.3 Auth model — login endpoint with bootstrap secret (dev and prod)

ADR 0027 amended ADR 0020 §2.1 to add a login endpoint behind a long-lived shared bootstrap secret. M10 consumes that contract:

- The dashboard has a `LoginScreen` with a single password-typed field: "Engine bootstrap secret."
- Operator workflow: operator types (or paste-from-password-manager) the value of `AUTH_BOOTSTRAP_SECRET` → submit.
- On submit, the dashboard `POST`s `/v1/auth/login` with `{ secret }`. On `200`, the response carries `{ token, expiresAt, scopes, subject }`.
- The token is stored in `sessionStorage`; `expiresAt` is stored alongside so the dashboard can pre-emptively re-prompt for login ~30s before expiry rather than wait for a hard 401.
- Token persists in `sessionStorage` (survives tab refresh, dies on tab close). Refresh = token still good if not expired; expiry = re-enter secret.
- Any 401 (REST or WS `auth.expired`) clears the token and routes back to `/login` with the prior URL stored for post-login redirect.
- Login failures surface the `IAuthFailure` shape (`BAD_SECRET`, `MALFORMED`) verbatim, plus the `IRateLimitFailure` shape on 429 with a countdown banner derived from `Retry-After`. The dashboard never echoes the typed secret back into the DOM after submit, and never logs it.

The CLI issuance path (`pnpm engine auth issue ...`) remains for ops/admin work (ADR 0027 §2.6) but the dashboard never invokes it.

Token storage = `sessionStorage`, not `localStorage`. Rationale unchanged:

- XSS captures either, equally.
- `sessionStorage` self-evicts on tab close — bounded blast radius.
- `localStorage` survives browser restart, encouraging the operator to skip the 15-min re-issue habit — exactly the wrong nudge for a panic-button-bearing token.

The bootstrap secret itself is **never** persisted by the dashboard. It lives only in the form input state until submit, then is cleared on response (success or failure). The operator is expected to keep it in a password manager.

### 2.4 Container topology

```
                       docker compose network
                       (default bridge, named)
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │  postgres:18.4-alpine (existing)                             │
   │    healthcheck: pg_isready                                   │
   │    volume: postgres-data                                     │
   │                                                              │
   │  engine (NEW in M10)                                         │
   │    image: built from apps/engine/Dockerfile                  │
   │    env: from root .env (DB_*, AUTH_*, EXCHANGE_*, ...)       │
   │    depends_on: postgres (service_healthy)                    │
   │    healthcheck: curl -fsS http://localhost:3000/v1/health    │
   │    ports: 3000 (host)                                        │
   │                                                              │
   │  dashboard (NEW in M10)                                      │
   │    image: built from apps/dashboard/Dockerfile (nginx-alpine)│
   │    depends_on: engine (service_healthy)                      │
   │    healthcheck: wget -qO- http://localhost/ >/dev/null       │
   │    ports: 8080:80                                            │
   │                                                              │
   │  adminer (existing, dev only)                                │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
```

Service-name DNS within compose: `engine`, `postgres`. nginx `proxy_pass http://engine:3000` resolves automatically. No engine URL ever appears in the dashboard's TypeScript.

Env wiring stays in the root `.env` (one source of truth, gitignored). `.env.example` enumerates every key. The dashboard container itself takes **no runtime env** — same-origin design means there is nothing to configure at the SPA layer.

### 2.5 nginx config sketch (production)

```
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # SPA: static asset → file; everything else → index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Long-cache hashed bundles, no-cache HTML
  location ~* \.(?:js|css|woff2|svg|png)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location = /index.html {
    add_header Cache-Control "no-store";
  }

  # REST passthrough
  location /v1/ {
    proxy_pass http://engine:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 30s;
  }

  # WS upgrade
  location /socket.io/ {
    proxy_pass http://engine:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
  }
}
```

Hardening (gzip, HSTS, X-Content-Type-Options, frame-ancestors `'none'`) is added in W5 and tightened in M11.

### 2.6 Kill-switch confirm UX contract

The kill switch is the most expensive mis-click in the system. The confirm flow is contractual, not cosmetic:

1. The button is **destructive red** (shadcn `variant="destructive"`), labelled `HALT TRADING`, full-width in its strip — unmistakable.
2. Click opens a modal `AlertDialog` (focus-trapped, blocks the page).
3. The dialog requires three pieces of input before the submit button enables:
   - **Reason** (free text, 1–256 chars; mirrors `POST /v1/control/halt` body validation per ADR 0021 §2.1).
   - **Flatten open positions?** (checkbox, **default off** — mirrors ADR 0021 §2.4's default-false semantic so the UI cannot drift from the server default).
   - **Type the word `HALT`** in a separate input (case-sensitive). Prevents fat-finger Enter on a focused submit.
4. On submit, the dashboard calls `POST /v1/control/halt` with the reason + flatten flag. Loading state shown.
5. Response handling:
   - `200` → close dialog, toast "Halted at `<haltedAt>` (audit id `<id>`)", banner immediately reflects (WS `halt.changed` will also fire — UI is idempotent).
   - `429` (rate-limited per ADR 0021 §2.2) → toast "Halt throttled. Retry in `<Retry-After>`s." The dialog stays open with state preserved.
   - `401` → clear auth + redirect; banner state unknown until re-login.
   - Other 5xx → toast with `IApiError.requestId`; dialog stays open.

Resume mirrors symmetrically (no flatten field, no `HALT` type-confirm — typing `RESUME` is required instead; resume is destructive in the other direction).

**Why type-the-word confirm not just "Confirm" button:** ADR 0021 §2.2 already throttles slammed halts (5/60s sliding window). The type-confirm defends against the muscle-memory case the rate-limit doesn't — a single, intentional-feeling but mistaken click. The combined defence (red colour + modal + reason + flatten checkbox + type-confirm + server rate-limit + server audit + server alert) is six layers; removing any one weakens the panic-button-not-poll-button contract.

### 2.7 Healthchecks and ordering

- `dashboard` depends on `engine` healthy; `engine` depends on `postgres` healthy. Compose ensures the bring-up order.
- The engine healthcheck hits `GET /v1/health` (ADR 0022 §2.2, unauthenticated). The dashboard healthcheck `wget`s the nginx root.
- The healthcheck does **not** verify the engine can reach Binance — that is a deeper liveness concern handled by ADR 0025's startup schema gate + the Telegram alert pipeline.

## 3. Consequences

- The dashboard is a static asset surface — zero Node runtime in the container — minimising attack surface and patch burden.
- Same-origin proxy keeps CORS scope minimal and TLS scope trivial when M11 adds HTTPS.
- Operator UX absorbs a small paste-the-token cost in exchange for zero auth surface inside the dashboard. M11 may revisit if multi-operator is in scope.
- The compose file grows from 2 services to 4 (postgres, adminer, engine, dashboard); the M11 hardening will likely split dev-only services into a compose overlay.
- The kill-switch confirm flow is contractually locked here. Dashboard rounds may not relax it without re-amending this ADR.

## 4. Alternatives considered

- **Next.js with SSR.** Rejected: no perceived-perf win for a single-operator dashboard; doubles the build/runtime surface; conflicts with the "no Node in dashboard container" intent.
- **Vercel hosting.** Rejected for M10: the engine is on a private docker network and won't be reachable from a public Vercel deployment without exposing the engine — exactly the surface M10/M11 want to avoid. Stays a Phase-2 option once the engine has a hardened edge proxy.
- **Direct CORS from browser to `engine:3000`.** Rejected: enlarges the CORS allow-list, leaks the engine origin to the browser, complicates TLS in M11. Same-origin proxy is the smaller surface.
- **`localStorage` for token.** Rejected: outlives tab close, encourages skipping the 15-min re-issue ritual, no upside given XSS captures either store.
- **In-memory-only token (no persistence).** Rejected: every F5 wipes auth — operators end up keeping the token on the clipboard, which is worse.
- **Paste-the-token (no login endpoint).** Originally chosen in this ADR's first draft; reversed by orchestrator override (D1) and locked in ADR 0027. The 15-minute re-paste cadence pushed operator habits toward longer TTLs — exactly the property ADR 0020 wanted to prevent. The login endpoint trades one unauthenticated POST (mitigated by layered rate-limit + 32-byte minimum secret + constant-time compare + full audit) for a meaningfully better operator UX.
- **HTTPS in M10.** Rejected: the dashboard runs on the operator's host on the loopback today. HTTPS is M11-hardening scope where a real reverse-proxy (Caddy/Traefik) terminates TLS — adding it in M10 just creates throwaway certificate workflow.
- **No type-the-word confirm on kill-switch.** Rejected: a single mis-click during a fast market event is the failure mode the UI exists to prevent; server-side rate-limit doesn't catch one bad click.
- **No flatten checkbox in UI (force a separate endpoint for flatten).** Rejected: ADR 0021 §2.1 already has the flag on the body; mirroring it in UI keeps server and client semantics aligned and surfaces the choice at the moment of decision.

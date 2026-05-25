# M10 — Dashboard (React, containerized)

**Goal:** A real-time, read-only dashboard to watch positions and performance, with
a single kill-switch button.

**Depends on:** M9 (read API + WS + halt endpoint).

## Tasks

- **React app** (Vite + TypeScript + shadcn/ui) consuming the M9 read API.
  - *Output:* app builds and authenticates against the engine API.
- **Live positions table** via WS/SSE: symbol, side, leverage, entry/current price, unrealized PnL, age.
  - *Output:* positions tick in real time.
- **Decisions feed.** Recent decisions with reason (acted/skipped).
  - *Output:* live decision log.
- **Performance-by-version view.** Win rate, PnL, drawdown per strategy version.
  - *Output:* comparison table/chart.
- **Kill-switch button** wired to the halt endpoint, with confirm step + auth.
  - *Output:* button halts trading; state reflected in UI.
- **Containerize.** Build the static bundle and serve it via an **nginx container** wired into `docker compose`. Reaches the engine API over the internal network in dev, and the authenticated engine endpoint in prod. Deployment topology in `M11-go-live-hardening.md`.
  - *Output:* dashboard container serving the live UI.

## Definition of done

The dashboard container shows real testnet positions updating in real time, a live
decision feed, per-version performance, and a working authenticated halt button.

## Outcome

**Completed definition-of-done:** Dashboard container serves live testnet positions with real-time WS updates, decision feed (paginated), per-version performance table (7/30/90-day windows), and fully functional authenticated kill-switch (halt + resume) with reason input, type-confirmation, and flatten-on-halt option.

**What shipped (beyond brief):**
- **Login endpoint (W0.5, ADR 0027):** `POST /v1/auth/login` with bootstrap-secret bootstrap for zero-paste-token UX on the dashboard. Engine-side: `LoginRateLimiter` (5/10s burst + 20/600s sustained + 200/60s global), constant-time SHA-256 comparison, `LoginRequestDto` + `LoginValidationFilter`, `ControlAuditRepository.appendLoginAudit`. Dashboard: `LoginScreen` posts secret, receives JWT, stores in sessionStorage.
- **ADRs 0026 + 0027:** Dashboard architecture (Vite + React 19 + TS strict + Tailwind v4 + shadcn/ui + TanStack Query v5 + socket.io-client), topology (engine + dashboard in compose, nginx reverse-proxy with CSP hardening, XFF overwrite), login endpoint contract + secret validation.
- **`engine-migrator` one-shot service:** Compose service ensuring migrations run before engine starts; optional `--profile dev` adminer for SQL inspection.
- **Containerisation:** Engine Dockerfile (multi-stage, `INCLUDE_DEV_LOGS` arg-gate pino-pretty), dashboard Dockerfile (nginx-unprivileged), `.env.example` comprehensively updated with `AUTH_BOOTSTRAP_SECRET`, `AUTH_LOGIN_SCOPES`, `AUTH_CORS_ALLOWLIST`, `KILL_SWITCH_FLATTEN_DEFAULT`.

**Test count at close:**
- Engine auth + control + alert + ws in scope: **170 tests** (LoginRateLimiter boundary, constant-time-compare approximation, audit row per outcome, BAD_SECRET opacity, admin-scope boot-fail).
- Dashboard greenfield (10 files, LoginScreen + auth context + WS hooks + kill-switch UI + read views): **152 tests** (auth 401/429/re-login, cache merge race, WS reconnect, dialog confirm flow, nginx SPA fallback, CORS preflight).
- Live-app compose smoke: **stack healthy ~22s**, XFF spoof rejection verified (nginx-stamped IP correctly attributed, spoofed first hop never reaches audit), LOGIN_SUCCESS/LOGIN_FAILURE rows written per attempt, zero console errors, testnet login + position/decision real-time updates working.
- **Total passing: 1,967 + 170 + 152 = 2,289 tests green.**

**Review history:** 3 rounds (R1 highs on XFF spoofing, rate-limit boundaries, audit DB timeout, float math, session invalidation; R2 mediums on LoginRequestDto validation, precomputed hash, secret length cap, dashboard polish; R3 minimal security fix XFF validated live-app). Zero blockers, zero highs at close. One high (XFF spoofing) resolved via live-app verification that nginx XFF overwrite prevents spoofed IPs from being recorded.

**Deferred to M11 / future:**
- `pino-pretty` dev-arg fallback (currently Dockerfile ARG-gated; better path is engine-side transport detection).
- CSP duplication on `/index.html` location block (nginx `add_header` scope; cosmetic, low risk).
- KillSwitchButton/ResumeButton dialog refactor (currently inlined; could split if more dialogs appear).
- `decimal.js-light` bundle size ~10 KB gzipped on dashboard (could code-split if bundle pressure grows).
- Stand-alone engine dev (`pnpm engine:dev`) requires manual `pnpm --filter @bot/engine migration:run` (documented in `.env.example`).

**Live-vs-backtest contract:** Unchanged. M10 ships zero strategy/risk/execution code; dashboard is a read-only consumer of M9 read API and WS gateway plus existing auth/halt control plane.

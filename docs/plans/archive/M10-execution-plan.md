# M10 — Execution plan (dispatch waves)

**Sibling to:** `docs/plans/archive/M10-dashboard.md` (task list / DoD).
**Authoritative ADRs:** 0020 (auth/CORS), 0021 (kill-switch), 0022 (read API), 0023 (WS gateway), 0026 (dashboard architecture & topology — new in this milestone), 0027 (login endpoint with bootstrap secret — new in this milestone, amends 0020 §2.1).
**Process rules:** `docs/best-practices/dev-qa-cycle.md` (≤5 files / ≤5 items per dispatch, paired tests, adversarial QA, reviewer continuity, architect on contract touches, orchestrator verifies diff).
**New surface:** `apps/dashboard/` (Vite + React 19 + TS + TanStack Query + Tailwind v4 + shadcn/ui + socket.io-client) and one new compose service `dashboard` (nginx-served static bundle).

## Wave summary

| Wave | Scope | Owner | Files (target) | Prereq |
|---|---|---|---|---|
| **W0** | Shared contracts gap-fill (login DTOs, query-key/WS-event/login-path constants, error shape, audit-action + auth-failure enum extensions) | bot-shared-maintainer | shared/ only ≤5 | — |
| **W0.5 (GATE)** | Engine: `AuthController.POST /v1/auth/login` + `LoginRateLimiter` (per-IP + global ceiling) + `AppConfigService` extension for `AUTH_BOOTSTRAP_SECRET` + `AUTH_LOGIN_SCOPES` + `ControlAuditRepository` extension for login rows | bot-engine-nestjs | ≤5 engine | W0 |
| **W1 (GATE)** | App skeleton: Vite + TS + Tailwind v4 + shadcn init + `apiClient` + auth bootstrap + router shell + `LoginScreen` posting `/v1/auth/login` | bot-dashboard-react | ≤5 dashboard | W0, W0.5 |
| **W2** | Read views: positions table, decisions feed, account/risk strip, per-version performance | bot-dashboard-react | ≤5 dashboard | W1 |
| **W3** | Live WS hook: socket.io-client wrapper, room subscriptions, query-cache merge, `stream.lagged` REST refetch, `auth.expired` re-login | bot-dashboard-react | ≤5 dashboard | W1, W2 |
| **W4** | Kill-switch UI: confirm dialog, halt/resume mutations, halt-banner, history drawer | bot-dashboard-react | ≤5 dashboard | W1, W2, W3 |
| **W5** | Containerise: multi-stage Dockerfile (build → nginx:alpine), nginx config (SPA fallback + reverse-proxy for `/v1/` and `/socket.io/`), compose service + engine service wiring, healthcheck | bot-devops | ≤5 infra | W1–W4 |
| **QA** | Adversarial coverage across all waves (see §QA) | bot-qa-engineer | tests only | W0.5, W1–W5 |
| **REVIEW** | Parallel security + logic + clean-code (quant N/A for read-only UI) | reviewers | — | QA |
| **SCRIBE** | Outcome section, runbooks (dashboard ops, login + secret rotation, kill-switch UX), live-app 10-min smoke | bot-scribe | docs | review-clean |

**Prerequisite gates:** W0.5 (engine login endpoint) MUST land and be reviewed clean before W1 dispatches — the dashboard's first paint depends on the endpoint existing. W1 must land before W2–W4 in series. W5 may dispatch in parallel with W4 because nginx/compose touches disjoint files from the React app. W0 → W0.5 is the new critical-path serial chain at the head of the milestone.

---

## W0 — Shared contracts gap-fill (bot-shared-maintainer)

Surface confirmed against current `packages/shared/src/interface/` listing — most M10 DTOs already exist (M9 W0 paid the cost). W0 adds the missing dashboard-facing primitives **and** the login-endpoint contract (per ADR 0027):

1. `packages/shared/src/interface/IAuthLogin.ts` — login request + response shape per ADR 0027 §2.1:
   - `ILoginRequest = { secret: string }`
   - `ILoginResponse = { token: string; expiresAt: string; scopes: AuthScopeEnum[]; subject: string }`
   - `AuthFailureReasonEnum` **extended** with `BAD_SECRET` (additive — non-breaking on M9 consumers).
   - `IRateLimitFailure.reason` **extended** with `TOO_MANY_LOGIN_ATTEMPTS` (additive).
   - `HaltAuditActionEnum` **extended** from `{HALT, RESUME}` to `{HALT, RESUME, LOGIN_SUCCESS, LOGIN_FAILURE, LOGIN_THROTTLED}` (additive — `IHaltAuditEntry` consumers keep working; dashboard history drawer renders new rows generically).
2. `packages/shared/src/const/readApiPaths.ts` — exported constants for every `/v1/*` path the dashboard hits. Keeps URL strings out of dashboard code; one place to audit when `/v2/` lands.
   - `READ_API_BASE = '/v1'`
   - `READ_API_PATHS = { health, authLogin, authRevoke, controlHalt, controlHaltHistory, controlResume, positionsOpen, positionsClosed, positionById, decisionsRecent, accountEquity, performanceByVersion, riskState } as const`
3. `packages/shared/src/const/wsEventNames.ts` — string-literal map for every WS event name in ADR 0023 §2.2 (`position.opened`, `position.updated`, `position.closed`, `decision.recorded`, `pnl.tick`, `halt.changed`, `risk.halt.engaged`, `model.divergence.engaged`, `auth.expired`, `stream.lagged`). Dashboard reuses; engine `LiveGateway` should also import in a follow-up clean-up (not required for M10 close).
4. `packages/shared/src/interface/IPnlTickEvent.ts` + `IStreamLaggedEvent.ts` — `IPnlTickEvent = { asOf: string; equityUsd: string; openExposureUsd: string; unrealizedPnlUsd: string }` (ADR 0023 §2.2); `IStreamLaggedEvent = { droppedCount: number; sinceMs: number }` (ADR 0023 §2.4). Bundled as one file-budget slot (both are tiny event payloads, mechanical-grade addition). **Verify on dispatch:** engine `LiveGateway` may emit the PnL payload via inline literal; if it diverges from `IPnlTickEvent`, route through architect.
5. `packages/shared/src/interface/IApiError.ts` — `{ code: string; message: string; requestId?: string }` (dashboard `ApiError` shape). Aligns with the engine's existing `IAuthFailure` and Nest's default error envelope so the `apiClient` can normalise both.

Barrel re-export from `packages/shared/src/index.ts` is a mechanical sibling touch and does not count against the cap (per `feedback-file-cap-pragmatism`).

**Exit criteria:** types compile in engine + future dashboard; `pnpm -r build` green; no engine code change beyond import re-shuffle if the engine `LiveGateway` payload diverges from `IPnlTickEvent` (route through architect if it does). W0.5 dispatches the moment W0 lands clean.

---

## W0.5 — Engine login endpoint (bot-engine-nestjs, GATE)

New engine wave, born from D1 override. Implements ADR 0027 against the existing `AuthModule` and `ControlModule` foundations. Files (target ≤5):

1. `apps/engine/src/auth/AuthController.ts` — `POST /v1/auth/login` handler. Validates body shape (`MALFORMED` on missing/empty `secret`), performs constant-time compare via `crypto.timingSafeEqual` against SHA-256 hash of both inputs (ADR 0027 §2.3), on success mints HS256 JWT via existing `TokenSigner` from W2 of M9 with scopes from `AppConfigService.authLoginScopes`, writes `LOGIN_SUCCESS` audit row, returns `ILoginResponse`. On failure writes `LOGIN_FAILURE` audit row and returns `IAuthFailure { reason: 'BAD_SECRET' }`. Endpoint NOT behind `AuthGuard` (it is the bootstrap path); behind `AuthCorsInterceptor` like every other route.
2. `apps/engine/src/auth/LoginRateLimiter.ts` — per-IP sliding-window limiter with two windows (10s/5 attempts; 600s/20 attempts) and a global ceiling (60s/200 attempts) per ADR 0027 §2.4. Mirrors `HaltRateLimiter` structural pattern (in-memory, periodic GC, prune-on-touch). Source IP from `X-Forwarded-For` first hop, fallback to `request.socket.remoteAddress`. On global ceiling breach emits one coalesced `CRITICAL` `IAlertPayload` of `AlertTypeEnum.UNHANDLED_EXCEPTION` (or a new `LOGIN_RATE_LIMIT_BREACHED` type — see §QA below) per minute.
3. `apps/engine/src/common/config/AppConfigService.ts` — extend with `authBootstrapSecret: string` (boot-validated: ≥32 bytes, no sentinels, not equal to `AUTH_SIGNING_SECRET` per ADR 0027 §2.3) and `authLoginScopes: readonly AuthScopeEnum[]` (parsed from `AUTH_LOGIN_SCOPES` comma list, default `['read','halt']`, `admin` in list = boot-fail per ADR 0027 §2.2). This is a contract-touching edit; the architect must be looped if M9's parser-parity test fails.
4. `apps/engine/src/control/repository/ControlAuditRepository.ts` — extend with `appendLoginAudit(action: 'LOGIN_SUCCESS'|'LOGIN_FAILURE'|'LOGIN_THROTTLED', { sourceIp, jti?, sub? })`. The `control_audit` schema (ADR 0021 §2.3) already permits the columns; only the `action` text column gets a wider value set (no migration — text column). The existing `findHistoryPage` continues to work without change because `IHaltAuditEntry` is shape-permissive.
5. Paired adversarial tests: `apps/engine/src/auth/AuthController.spec.ts` + `LoginRateLimiter.spec.ts`. Asserts constant-time-compare property (timing-equivalence test approximated by exercising 0-prefix vs same-prefix mismatched secrets); 10s/5 boundary; 600s/20 boundary; global ceiling; `BAD_SECRET` opacity (correct-shape-wrong-secret produces same reason as wrong-shape that passes JSON parse); audit-row written on every outcome including throttle; `admin` in `AUTH_LOGIN_SCOPES` rejected at boot.

**Exit criteria:** `curl -X POST http://localhost:3000/v1/auth/login -d '{"secret":"<32+byte secret>"}'` returns `{token, expiresAt, scopes:['read','halt'], subject:'operator'}`; wrong secret returns 401 `BAD_SECRET`; six rapid attempts return 429; audit table shows one row per attempt with correct action; returned token verifies against `AuthGuard` on any other endpoint; reviewer (security) signs off on the constant-time-compare pattern.

**Contract-touch flag:** W0.5 modifies `AppConfigService` (M9 R1 adjudication F made it the single source for env reads — touching it requires architect ack). This ADR is the architect ack. Engineer should still ping if the parser-parity test exercises something unexpected.

---

## W1 — App skeleton (bot-dashboard-react, GATE)

Creates `apps/dashboard/` as a pnpm workspace package `@bot/dashboard`. File-budget interpretation: scaffolding is mechanical — a Vite create generates ~12 boilerplate files. The ≤5 cap applies to **hand-written** files; framework boilerplate (vite.config.ts, tsconfig.json, index.html, main entrypoint, postcss/tailwind config, shadcn init output) counts as one mechanical bucket per `feedback-file-cap-pragmatism`.

Hand-written files (target ≤5):

1. `apps/dashboard/src/api/apiClient.ts` — `fetch` wrapper: attaches `Authorization: Bearer <token>`, normalises errors into `IApiError`, throws typed `ApiError` on 401 (auth context handles).
2. `apps/dashboard/src/auth/AuthContext.tsx` — token state (in-memory + sessionStorage), `useAuth()` hook, `login(token)` / `logout()`, 401 listener that clears + reroutes.
3. `apps/dashboard/src/auth/LoginScreen.tsx` — single password-typed field "Engine bootstrap secret" (see ADR 0026 §2.3, ADR 0027 §2.1). Submit `POST`s `READ_API_PATHS.authLogin` with `{ secret }`; on `200` stores `token` + `expiresAt` in sessionStorage + routes to `/` (or saved redirect target); on 401 surfaces `IAuthFailure.reason`; on 429 starts a countdown banner from `Retry-After`. The typed secret is cleared from form state on response regardless of outcome.
4. `apps/dashboard/src/App.tsx` — React Router shell: `/login`, `/` (dashboard), `/positions/:id`. Wraps in `QueryClientProvider` (default `staleTime: 30s`, `gcTime: 5m`, `refetchOnWindowFocus: false` for the dashboard's character — operator stares at one tab).
5. `apps/dashboard/src/queries/queryKeys.ts` — TanStack Query key factory. One entry per resource (`positions.open()`, `positions.closed(cursor)`, `decisions.recent(cursor)`, `account.equity()`, `performance.byVersion(windowDays)`, `risk.state()`, `control.halt()`, `control.haltHistory(cursor)`).

Boilerplate bucket (one mechanical file group, does not count): `vite.config.ts` (with dev proxy — see §Dev wiring), `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/index.css` (Tailwind v4 entry), `tailwind.config.ts`, `postcss.config.cjs`, `components.json` (shadcn), `package.json` (workspace dep on `@bot/shared`), `.eslintrc` extends root.

**Exit criteria:** `pnpm dashboard:dev` runs Vite on `5173`, proxies `/v1/*` and `/socket.io/*` to engine `:3000`, the LoginScreen exchanges the bootstrap secret for a token via `POST /v1/auth/login`, and the post-login shell renders an empty page guarded by auth. Auth context also accepts CLI-issued tokens (operators / scripts may bypass the UI flow).

---

## W2 — Read views (bot-dashboard-react)

Hand-written files (target ≤5):

1. `apps/dashboard/src/features/positions/OpenPositionsTable.tsx` — shadcn `<Table>` over `IOpenPositionView[]`. Columns: symbol, side, leverage, entry, current, unrealized PnL (price + funding shown separately per ADR 0022 §2.3.1), age, slot, version. Row click → `/positions/:id`.
2. `apps/dashboard/src/features/decisions/DecisionsFeed.tsx` — virtualised list over paginated `/v1/decisions/recent`. Cursor pagination wired through `useInfiniteQuery`. Color-codes action (`open`/`add`/`reduce`/`close`/`skip`).
3. `apps/dashboard/src/features/performance/PerformanceByVersionTable.tsx` — sortable table of `IPerformanceByVersionView[]` with windowDays selector (7/30/90). Null cells render as "—" not "0" (preserves ADR 0022 §2.3.1 intent).
4. `apps/dashboard/src/features/account/AccountStrip.tsx` — top-of-page strip: equity, free margin, open exposure, today's realized PnL, halt-state pill. Reads `account/equity` + `risk/state`.
5. `apps/dashboard/src/pages/DashboardPage.tsx` — composes the four widgets. Uses `useQueries` to fan out the initial loads.

`PositionDetailPage` deferred to W4 (it's a leaf and the wave budget is tight; W4 already touches detail rendering for the history drawer).

**Exit criteria:** with a populated testnet DB, the dashboard renders all four widgets from REST polling only (no WS yet). Polling interval 10s for account/risk/perf (cheap), 5s for positions/decisions. Visual quality target = "operator-grade not designer-grade" — Tailwind defaults + shadcn primitives, no custom theme.

---

## W3 — Live WS hook (bot-dashboard-react)

Hand-written files (target ≤5):

1. `apps/dashboard/src/realtime/liveSocket.ts` — socket.io-client singleton factory. Connects with `auth: { token }`, reconnects with backoff (built-in), exposes typed `on(eventName, handler)` against `wsEventNames`. Handles `auth.expired` by clearing auth + redirecting to `/login`. Handles `stream.lagged` by triggering a TanStack Query `invalidateQueries` on the affected resource.
2. `apps/dashboard/src/realtime/useLivePositions.ts` — hook: subscribes to room `positions`, merges `position.opened/updated/closed` events into the `positions.open()` query cache via `queryClient.setQueryData`. Stale-on-error: if WS drops, the polling query takes over.
3. `apps/dashboard/src/realtime/useLiveDecisions.ts` — same pattern for room `decisions`: prepends `decision.recorded` events into the infinite-query first page.
4. `apps/dashboard/src/realtime/useLivePnlTick.ts` — subscribes to room `pnl`, mutates the account-equity cache with the latest tick. Throttled visually (no need beyond the 1Hz server coalescing).
5. `apps/dashboard/src/realtime/useLiveControl.ts` — subscribes to room `control`, mutates the `control.halt()` cache on `halt.changed`, surfaces a transient toast on `risk.halt.engaged` / `model.divergence.engaged`.

**Exit criteria:** with the engine running, the dashboard shows ticks within ~1s of an event; killing the WS server drops the dashboard into REST-only polling without UI break; restarting it reconnects automatically.

---

## W4 — Kill-switch UI (bot-dashboard-react)

Hand-written files (target ≤5):

1. `apps/dashboard/src/features/control/KillSwitchButton.tsx` — destructive red button. Click opens shadcn `<AlertDialog>` with: free-text reason field (required, max 256 — matches ADR 0021 §2.1), `flattenOpenPositions` checkbox (default unchecked per ADR 0021 §2.4), explicit type-the-word-`HALT` confirmation input. Submit calls `POST /v1/control/halt`.
2. `apps/dashboard/src/features/control/ResumeButton.tsx` — symmetric. Shown only when current state is `HALTED`. Same dialog discipline minus the flatten toggle.
3. `apps/dashboard/src/features/control/HaltBanner.tsx` — sticky banner when `IKillSwitchState.haltState === 'HALTED'`. Shows source, reason, audit id, `flattenInProgress` if true.
4. `apps/dashboard/src/features/control/HaltHistoryDrawer.tsx` — paginated list of `IHaltAuditEntry` from `/v1/control/halt/history`. Shown via a "history" button in the banner / header.
5. `apps/dashboard/src/features/positions/PositionDetailPage.tsx` — moved from W2; renders `IPositionDetailView` (deferred-from-W2). Bundled here because the kill-switch wave already touches detail/drawer rendering patterns.

**Exit criteria:** halt button requires reason + typed-confirmation + auth scope `halt`; halt round-trips to engine; banner appears within 1s via WS; resume mirrors; rate-limit 429s render with a clear "wait Xs" message.

---

## W5 — Containerise (bot-devops, parallel-eligible after W4 starts)

Files (target ≤5):

1. `apps/dashboard/Dockerfile` — multi-stage: `node:22-alpine` builder runs `pnpm install --frozen-lockfile && pnpm --filter @bot/dashboard build`; final `nginx:1.27-alpine` stage copies `dist/` to `/usr/share/nginx/html`.
2. `apps/dashboard/nginx.conf` — `try_files $uri $uri/ /index.html` for SPA routing; `location /v1/ { proxy_pass http://engine:3000; }` and `location /socket.io/ { proxy_pass http://engine:3000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }`; gzip on; cache-control headers per ADR 0026.
3. `apps/engine/Dockerfile` — **NEW** if missing (compose currently has no engine service). Multi-stage `node:22-alpine`; `CMD ["node", "dist/main.js"]`; `HEALTHCHECK` curl `/v1/health`.
4. `docker-compose.yml` — adds `engine` and `dashboard` services; both attached to the existing default network; `engine` depends on `postgres` healthy; `dashboard` depends on `engine` healthy; env wired from root `.env`; ports `3000` (engine) and `8080` (dashboard) exposed on host.
5. `.env.example` update — `AUTH_SIGNING_SECRET`, `AUTH_BOOTSTRAP_SECRET` (32+ bytes, must differ from signing secret — per ADR 0027 §2.3), `AUTH_LOGIN_SCOPES=read,halt` (default; `admin` rejected at boot), `AUTH_CORS_ALLOWLIST=http://localhost:8080,http://localhost:5173`, `KILL_SWITCH_FLATTEN_DEFAULT=false`, plus reminder lines for `TELEGRAM_*`.

Boilerplate sibling: `apps/dashboard/.dockerignore`, `apps/engine/.dockerignore` — mechanical, do not count.

**Exit criteria:** `docker compose up --build` brings up postgres → engine (healthy) → dashboard; visiting `http://localhost:8080` loads the SPA; LoginScreen accepts a CLI-issued token; positions/decisions/PnL/halt all work over the in-network proxy without dashboard knowing the engine URL.

---

## QA wave (after W5)

Adversarial coverage per dev-qa-cycle §2.2. Dashboard tests live under `apps/dashboard/src/**/*.spec.tsx` (Vitest + @testing-library/react). Must include:

- **Auth (dashboard side):** LoginScreen rejects empty / whitespace-only secret client-side; 401 `BAD_SECRET` renders with no echo of the typed secret; 429 `TOO_MANY_LOGIN_ATTEMPTS` renders a Retry-After countdown that blocks resubmit; mid-session 401 from REST clears auth + redirects; mid-session `auth.expired` over WS clears auth + redirects; pre-emptive re-login banner appears ~30s before `expiresAt`.
- **Auth (engine W0.5):** wrong secret returns 401 in constant time (within tolerance — sample-mean comparison across 1000 attempts); 6th attempt in 10s returns 429; 21st attempt in 600s returns 429; global ceiling at 200/60s returns 429 across all IPs; `LOGIN_SUCCESS`/`LOGIN_FAILURE`/`LOGIN_THROTTLED` rows present in `control_audit` per outcome; the bootstrap-secret value never appears in any log line, response body, or audit row (greppable assertion); token returned by login passes `AuthGuard` on `GET /v1/control/halt`; `admin` in `AUTH_LOGIN_SCOPES` env triggers boot-fail; secret equal to `AUTH_SIGNING_SECRET` triggers boot-fail; 31-byte secret triggers boot-fail.
- **Query layer:** WS update for a position the cache has not loaded yet (no crash); `stream.lagged` triggers exactly one `invalidate` not a loop; REST 5xx surfaces a typed `ApiError` and the table shows a row-level retry, not a blank.
- **Kill-switch UI:** dialog blocks submit until reason non-empty + type-confirmation matches; 429 from server renders Retry-After countdown; halt-then-halt (already halted) shows a "no state change" notice + still records audit id.
- **Realtime:** WS dropped → polling continues seamlessly; reconnect within 5s after re-up; `position.updated` for a closed position is ignored (idempotent merge); `pnl.tick` rate exceeding 5/s is visually throttled (sanity check on top of server coalescing).
- **Containerisation:** nginx serves SPA fallback for any unknown route; WebSocket upgrade through nginx succeeds; CORS preflight from `localhost:8080` succeeds and from `evil.example` fails with the engine's `CORS_FORBIDDEN` shape.
- **Live-app smoke (mandatory, per `feedback-milestone-app-smoke`):** 10-minute `docker compose up` against testnet — log in, watch a position open and close, fire halt + resume, observe banner + audit + Telegram alert (if configured), verify no console errors.

Failures route per dev-qa-cycle §2.2: dashboard bug → bot-dashboard-react; contract gap (engine emits different shape than ADR 0023) → architect adjudication, then engine fix via bot-engine-nestjs.

---

## REVIEW wave

Three parallel reviewers (security, logic, clean-code). Quant skipped — M10 ships zero strategy/risk code. Continue rounds until zero blockers, zero highs, majority of mediums resolved.

Reviewer focus splits:

- **security:** token storage (sessionStorage vs in-memory tradeoff), XSS in `reason`/`haltReason` rendering, dependency CVEs in the React 19 / Vite 5 stack, nginx config hardening, secret leakage in console.
- **logic:** TanStack Query cache merge correctness, race between REST snapshot + first WS event, halt-banner state machine, kill-switch confirm flow.
- **clean-code:** component decomposition vs the file-cap pragmatism rule, hook reuse, no `any`, `I`-prefix discipline, no duplicated DTO types.

---

## SCRIBE

- `docs/runbooks/dashboard-operations.md` (start/stop, token issuance reminder, common UI errors).
- `docs/runbooks/kill-switch-operations.md` — extend the M9 runbook with the dashboard UX path (confirm dialog, banner, history drawer).
- M10 outcome section in `docs/work-log.md`.
- `CLAUDE.md` status flip M10 → DONE; "Next" pointer to M11.

---

## Engine-side contract gaps surfaced (must land before / during M10)

Cross-checked the dashboard's needs against `apps/engine/src/read-api/`, `apps/engine/src/ws/`, `apps/engine/src/auth/`, `apps/engine/src/control/`. Findings:

| # | Gap | Fix path | Blocking? |
|---|---|---|---|
| G1 | No `IPnlTickEvent` shared type yet; engine `LiveGateway` emits the payload via inline literal. | W0 lands the type; engine import is a mechanical follow-up if the literal diverges. | Soft — confirm at W0 dispatch. |
| G2 | No `IStreamLaggedEvent` shared type yet. | W0. | Soft. |
| G3 | No `IApiError` shared type — engine error envelopes are Nest defaults + the M9 `IAuthFailure`. Dashboard needs a unified shape. | W0. The `apiClient` normalises Nest's default `{ statusCode, message, error }` into `IApiError` client-side; no engine change required. | Non-blocking. |
| G4 | Engine `Dockerfile` does not exist. M9 closed without one (the live-app smoke ran via `pnpm engine:dev`, not container). | W5 adds it. | **Blocks W5 only.** |
| G5 | `docker-compose.yml` has no `engine` service — only postgres + adminer. | W5 wires both `engine` and `dashboard`. | **Blocks W5 only.** |
| G6 | `AUTH_CORS_ALLOWLIST` default in prod is empty (ADR 0020 §2.3). The compose smoke needs the dashboard origin populated; `.env.example` must document the dev value. | W5 `.env.example`. | Blocks smoke, not W1–W4. |
| G7 | No login endpoint exists in M9. **D1 overrode** the original paste-the-token plan; ADR 0027 adds `POST /v1/auth/login` with bootstrap secret. | W0.5 (new engine wave) ships the endpoint; W1 LoginScreen consumes it. | **Blocks W1.** |
| G8 | `IPositionDetailView` shape is locked but the `GET /v1/positions/:id` endpoint exists in M9 — confirm it returns the full ADR 0022 §2.3 shape with the W9 R1 renames. | Engine check during W2 cache priming; if mismatch, architect adjudication. | Non-blocking until W2 dispatches. |
| G9 | WS gateway requires `subscribe` per room (ADR 0023 §2.2). Dashboard must subscribe before any updates flow. The `useLiveX` hooks own this. | W3 hook design. | Non-blocking. |
| G10 | Engine `/v1/health` is unauthenticated (ADR 0022 §2.2). Used only as a connectivity probe by the dashboard, never as token validation (the login endpoint is the validation path). | W1 design note. | Non-blocking, design note. |

**One new engine endpoint is required** for M10: `POST /v1/auth/login` (ADR 0027, W0.5). All other dashboard surfaces map to existing M9 endpoints or WS events.

---

## Decisions needed from the orchestrator before W0 dispatches

**D1 — Token bootstrap UX in dev and prod. [RESOLVED — login endpoint chosen]**

- Decision: `POST /v1/auth/login` with bootstrap secret (per ADR 0027). Engine W0.5 implements; dashboard W1 consumes. CLI issuance path (`pnpm engine auth issue`) retained for ops/admin/scripted work.
- Implications: one new engine wave (W0.5) on the critical path; the dashboard never paste-imports a JWT; the bootstrap secret is the operator's sole long-lived credential, rotated manually.

**D2 — Token storage location.**

- Options: `sessionStorage` (survives tab refresh, no cross-tab leak), `localStorage` (survives browser restart), in-memory only (re-paste after every reload).
- Recommendation: **sessionStorage** — balances UX (no re-paste on F5) against blast-radius (closing the tab kills the token; XSS gets the token regardless). Confirm.

**D3 — Dashboard host port.**

- Plan: `8080` on host (nginx listens 80 in-container). Engine on `3000`. Postgres on `5432`.
- Confirm `8080` is free in your dev env; if not, switch to `5173` parity with vite dev.

**D4 — Polling intervals when WS is healthy.**

- Plan: positions 5s, decisions 5s, account/risk/perf 10s. WS reduces effective latency but polling stays on as a belt-and-braces sanity check.
- Alternative: WS-only, polling triggered solely by `stream.lagged`. Cheaper but rougher UX on WS drops.
- Recommendation: **keep polling on** at the modest intervals above; it's free server-side (read API is a thin mapper). Confirm.

**D5 — Strategy-comparison UI scope.**

- M10 brief mentions "Performance-by-version view: win rate, PnL, drawdown per strategy version." M8 added far more (Sharpe, Sortino, expectancy-per-unit-risk, per-regime breakdown, paired bootstrap CIs).
- Plan: W2 ships the flat table from `/v1/performance/by-version` only. **Walk-forward / OOS / bootstrap-CI views deferred to M11 or a dedicated M10.5** — they need new endpoints and dedicated chart components (recharts dep).
- Recommendation: **flat table for M10, full comparison UI deferred.** Confirm.

**D6 — Recharts (or any chart lib) in M10?**

- Plan: **no charts in M10.** Tables + sparklines-via-CSS if anything. Charts arrive when D5 deferrals land.
- Reduces dep surface, review surface, and bundle size. Confirm.

---

## Pre-M11 deferred (catalogued from M10 design)

- Multi-operator UX (per-operator credentials, rotate-token banner, per-operator audit attribution in the UI).
- Graceful bootstrap-secret rotation (overlap window allowing both old + new secrets during cutover) — M10 ships hard cutover (stop engine, swap env, restart).
- Redis-backed shared `LoginRateLimiter` (M10 is in-memory single-process; multi-instance scaling is M11).
- Strategy comparison UI: walk-forward OOS splits, paired bootstrap CIs, per-regime tables, promotion-gate visual (D5).
- Charting: equity curve, drawdown curve, per-symbol PnL bars (D6).
- Real-time depth / order book visualisation around an open position.
- Mobile / narrow-viewport layout — desktop-only in M10.
- Browser-extension or PWA install for halt button (M11+ if external access becomes a goal — currently disallowed by ADR 0020).
- HTTPS termination / reverse-proxy (Caddy/Traefik) — deferred to M11 hardening; M10 ships over plain HTTP on the docker network.

---

## Live-vs-backtest invariant — confirmed

M10 ships zero code into the strategy, risk gate, executor, reservation ledger, deterministic clock, or any persistence write path. The dashboard is strictly a consumer of the M9 read API and WS gateway, plus the existing operator HTTP control plane. The live↔backtest contract (`docs/architecture/live-vs-backtest-contract.md`) is unchanged.

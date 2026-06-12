# M0 — Foundation & scaffolding

**Goal:** A booting NestJS app wired to Postgres with the shared primitives every
later module depends on.

**Depends on:** nothing.

## Tasks

- **Scaffold NestJS + TypeScript project.** ESLint/Prettier aligned to the project clean-code rules.
  - *Output:* `npm run start:dev` boots; lint passes.
- **Config module.** Typed env loading (exchange keys, DB URL, Telegram, API auth token, risk limits) with validation; fail fast on missing required vars. **All secrets flow through the config layer (and in prod, the cloud secret manager) — never committed `.env`, never hard-coded.**
  - *Output:* invalid/missing config aborts startup with a clear message; no secret has a committed default.
- **Global halt-flag primitive** in CommonModule (the kill switch's backing state). Lives here so M6 can record a `kill_switch` exit reason before M9 builds the endpoint on top.
  - *Output:* a process-wide halt flag readable/settable via DI, default off.
- **Docker Compose for Postgres.** Local DB + adminer/psql access.
  - *Output:* `docker compose up` gives a reachable Postgres.
- **TypeORM connection** with migrations enabled (no `synchronize` in any env).
  - *Output:* app connects; empty migration runs cleanly.
- **Shared CommonModule primitives:** `decimal.js` money helpers, structured logger, `@nestjs/event-emitter` bus, `@nestjs/schedule`.
  - *Output:* a sample event round-trips through the bus; logs are structured JSON.
- **Health endpoint** (`/health`) — minimal liveness only (no internal version/DB detail leaked); confined to the private network in prod.
  - *Output:* `GET /health` returns 200 without exposing internals.
- **Write initial `CLAUDE.md`** documenting setup, commands, and architecture.
  - *Output:* `CLAUDE.md` at repo root.

## Definition of done

Repo boots, connects to Postgres via TypeORM, exposes `/health`, event bus and
scheduler are wired, money helpers and structured logging are in place, and
`CLAUDE.md` exists.

## Outcome / Review rounds

**Status:** DONE. All DoD items delivered and verified.

**Review Round 1 findings** (all fixed):
- Money-helper dead guard + missing number signature in `formatMoney`.
- Config module missing NaN fail-fast check for risk-limit floats.
- `EXCHANGE_TESTNET` live-on-typo risk (added validation).
- Single-level log redaction (recursive scrubber implemented).
- `BaseRepository<T>` unsafe `as never` cast (typed properly).
- `packages/shared` barrel and type nit exports.

**Review Round 2 findings** (all fixed):
- Magic string constant extraction (`'HaltFlagService'` → named const).
- Dead export removal in shared barrel.
- Test minor style nit.

**Carry-over items** (deferred to later milestones):
- Float risk-limit config getters (`maxExposurePerCoinUsdt`, `dailyLossLimitUsdt`, `accountCapitalUsdt`) → convert via `parseMoney` at boundary in **M3**.
- Dual rounding context (HALF_EVEN accounting) for PnL/fees → **M3**.
- `HaltReasonEnum` (typed halt reason) → **M6**.
- Global `ValidationPipe` + `@nestjs/throttler` → **M9** (control/auth endpoints).
- CI root `engines` Node 22 (M0 verified on Node 20) → **M14**.
- `.env.example` `DB_PASSWORD` placeholder annotation → **CI/prod env work**.
- Minor: `packages/shared` TypeScript ^5.4.5 vs root 5.9.3 alignment (non-blocking, resolves under pnpm).

See `docs/work-log.md` for full entry.

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

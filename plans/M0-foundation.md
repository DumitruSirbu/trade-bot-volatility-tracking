# M0 — Foundation & scaffolding

**Goal:** A booting NestJS app wired to Postgres with the shared primitives every
later module depends on.

**Depends on:** nothing.

## Tasks

- **Scaffold NestJS + TypeScript project.** ESLint/Prettier aligned to the project clean-code rules.
  - *Output:* `npm run start:dev` boots; lint passes.
- **Config module.** Typed env loading (exchange keys, DB URL, Telegram, risk limits) with validation; fail fast on missing required vars.
  - *Output:* invalid/missing config aborts startup with a clear message.
- **Docker Compose for Postgres.** Local DB + adminer/psql access.
  - *Output:* `docker compose up` gives a reachable Postgres.
- **TypeORM connection** with migrations enabled (no `synchronize` in any env).
  - *Output:* app connects; empty migration runs cleanly.
- **Shared CommonModule primitives:** `decimal.js` money helpers, structured logger, `@nestjs/event-emitter` bus, `@nestjs/schedule`.
  - *Output:* a sample event round-trips through the bus; logs are structured JSON.
- **Health endpoint** (`/health`) reporting app + DB status.
  - *Output:* `GET /health` returns 200 with DB connectivity.
- **Write initial `CLAUDE.md`** documenting setup, commands, and architecture.
  - *Output:* `CLAUDE.md` at repo root.

## Definition of done

Repo boots, connects to Postgres via TypeORM, exposes `/health`, event bus and
scheduler are wired, money helpers and structured logging are in place, and
`CLAUDE.md` exists.

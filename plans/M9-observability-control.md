# M9 — Observability, control & read API

**Goal:** Know what the bot is doing, halt it instantly, and expose a read API the
dashboard will consume.

**Depends on:** M6 (positions), M5 (execution honors halt).

## Tasks

- **Auth FIRST (prerequisite gate).** Stand up the auth guard before any endpoint is wired. **Bearer tokens (or mTLS) from the secret manager, with rotation** — no static/basic credentials, none committed. A CORS allow-list restricts origins to the dashboard only. No endpoint — especially halt — exists before the guard is in place.
  - *Output:* every endpoint rejects unauthenticated/cross-origin requests from the moment it exists.
- **Telegram alerts** on open/close/error/halt + a daily PnL summary. Redact secrets; no keys/tokens in messages.
  - *Output:* a phone message on every trade and error, no sensitive leakage.
- **Kill switch.** Authenticated endpoint over the M0 halt flag; execution refuses new entries when halted. **Flatten-on-halt is a config flag with a stated default.** The endpoint is **rate-limited** and every toggle is **audit-logged** (actor, timestamp, source IP).
  - *Output:* one action stops new trading; honored by ExecutionModule; toggles are throttled and audited.
- **Read API (REST).** Snapshots: open positions, PnL, recent decisions, performance-by-version, account equity. Authenticated; least-disclosure payloads.
  - *Output:* authenticated REST endpoints returning current state.
- **Live updates (WS/SSE) gateway.** Push position/PnL/decision updates to authenticated subscribers.
  - *Output:* a WS client receives live ticks only when authenticated.

## Definition of done

The auth guard gates all endpoints from creation; phone alerts fire on trades; the
bot can be halted in one authenticated, rate-limited, audited action; an
authenticated, CORS-restricted API streams live state, verified with a WS client.

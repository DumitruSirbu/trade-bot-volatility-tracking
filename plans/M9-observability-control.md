# M9 — Observability, control & read API

**Goal:** Know what the bot is doing, halt it instantly, and expose a read API the
dashboard will consume.

**Depends on:** M6 (positions), M5 (execution honors halt).

## Tasks

- **Telegram alerts** on open/close/error/halt + a daily PnL summary.
  - *Output:* a phone message on every trade and error.
- **Kill switch.** Global halt flag + authenticated endpoint; execution refuses new entries when halted (optionally flattens).
  - *Output:* one action stops new trading; honored by ExecutionModule.
- **Read API (REST).** Snapshots: open positions, PnL, recent decisions, performance-by-version, account equity.
  - *Output:* authenticated REST endpoints returning current state.
- **Live updates (WS/SSE) gateway.** Push position/PnL/decision updates to subscribers.
  - *Output:* a WS client receives live ticks.
- **API authentication.** Token/basic auth on all endpoints; halt endpoint is the only permitted write.
  - *Output:* unauthenticated requests rejected.

## Definition of done

Phone alerts fire on trades; the bot can be halted in one authenticated action;
an authenticated API streams live state, verified with a WS client.

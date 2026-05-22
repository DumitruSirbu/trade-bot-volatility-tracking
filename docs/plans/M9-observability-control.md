# M9 — Observability, control & read API

**Goal:** Know what the bot is doing, halt it instantly, and expose a read API the
dashboard will consume.

**Depends on:** M6 (positions), M5 (execution honors halt).

## Tasks

- **Auth FIRST (prerequisite gate).** Stand up the auth guard before any endpoint is wired. **Short-lived bearer tokens (or mTLS) from the secret manager, with server-side revocation** — define TTL and a revocation path; no static/basic credentials, none committed. A CORS allow-list restricts origins to the dashboard only. No endpoint — especially halt — exists before the guard is in place.
  - *Output:* every endpoint rejects unauthenticated/cross-origin requests; a revoked token stops working immediately.
- **Telegram alerts (strictly outbound)** on open/close/error/halt + a daily PnL summary (aligned to the UTC risk-day). **No inbound command handling** — Telegram is never a control path. Redact secrets; no keys/tokens in messages.
  - *Output:* a phone message on every trade and error, outbound-only, no sensitive leakage.
- **Kill switch.** Authenticated endpoint over the M0 halt flag; execution refuses new entries when halted. **Flatten-on-halt is a config flag with a stated default.** The endpoint is **rate-limited** and every toggle is **audit-logged** (actor, timestamp, source IP).
  - *Output:* one action stops new trading; honored by ExecutionModule; toggles are throttled and audited.
- **Surface risk halts + model divergence.** Expose and **alert via Telegram** on the M4 **global market-stress halt** (BTC/ETH shock, breadth, same-bar trigger count, OI/funding/spread extremes) and the **model-divergence kill switch** (live-vs-modeled slippage gap; realized-vs-expected distribution drift). These must be visible in the read API and push an alert when they engage.
  - *Output:* engaging either halt produces a Telegram alert and a read-API state change; both are audit-logged.

- **Read API (REST).** Snapshots: open positions, PnL, recent decisions, performance-by-version, account equity. Authenticated; least-disclosure payloads.
  - *Output:* authenticated REST endpoints returning current state.
- **Live updates (WS/SSE) gateway.** Push position/PnL/decision updates to authenticated subscribers. **Validate the token at handshake AND re-validate on expiry** — a long-lived connection authenticated once must not stream forever; force re-auth on token expiry/revocation.
  - *Output:* a WS client receives live ticks only while holding a valid, unexpired token.

## Definition of done

The auth guard gates all endpoints from creation; phone alerts fire on trades; the
bot can be halted in one authenticated, rate-limited, audited action; an
authenticated, CORS-restricted API streams live state, verified with a WS client.

# M11a — Local soak hardening

**Goal:** Make the existing stack production-grade on a single trusted machine so
the user can run a multi-week **Binance demo-trading** soak at $0 infra cost and
collect real signal on the strategies before any cloud spend.

**Depends on:** M1–M10.
**Follows into:** M11b (cloud go-live) — only entered once the soak confirms a
live edge worth paying ~$30–60/mo to host.

## Why split M11

The original M11 conflated two very different problems:

1. **Operate the bot safely on hardware you already own**, against Binance demo
   trading, for weeks, while you observe whether the strategies actually work.
2. **Move the same stack to a cloud with managed Postgres, private networking,
   secret manager, static egress IP, multi-instance, external reverse proxy.**

For an account sized $500–$1,000 with a target of survival over returns, paying
$30–60/mo in infra before there is *any* evidence of live edge is negative-EV. The
local soak is the gating experiment; the cloud topology is the prize you pay for
only if the experiment succeeds.

M11a contains every safety rail that applies **regardless of where the engine
runs**, plus everything specific to the local-machine deployment.

## Tasks

### Exchange & key safety

- **Binance demo-trading migration.** Move off `testnet.binancefuture.com` to
  Binance's official demo trading (paper trading against live order books). Update
  `CcxtBinanceExchangeClient` config, document the API-key procurement steps, and
  re-verify the M5 testnet smoke runbook against demo.
  - *Output:* engine places paper orders against live order-book depth; the
    existing testnet path is retired or feature-flagged for regression only.
- **Startup key-permission assertion.** On boot, query the Binance key's
  permissions/IP-restriction via ccxt and **abort startup if withdrawal scope is
  enabled or the IP allow-list is empty.** Makes the no-withdrawal invariant
  verifiable, not just asserted. Applies to demo and live keys identically.
  - *Output:* a key with withdrawal rights (or an empty IP allow-list) prevents
    the engine from starting.
- **WebSocket resilience.** Reconnect with backoff; detect stale streams; alert
  on stalls via the existing Telegram sink.
  - *Output:* simulated drops recover automatically with an alert.
- **Rate-limit guards.** Respect Binance limits; queue/throttle order calls.
  - *Output:* no rate-limit bans under burst conditions.

### Auth & secrets (local)

- **Auth rotation.** Carry the pre-M11 deferred items that block a long-running
  deployment:
  - `AuthFailureReasonEnum.BAD_SIGNATURE` split (separate signature failures from
    other auth failures in audit + metrics);
  - revoked_jti TTL prune (revoked-token table must not grow unbounded over weeks);
  - HKDF cursor sub-key derivation (separate keys for cursor encryption vs auth
    signing).
  - *Output:* a running engine can rotate the JWT signing secret without
    operator-visible downtime; revoked_jti stays bounded; cursors don't share a
    key with auth.
- **Secrets in `.env`, file-permission hardened.** Live + demo Binance keys, JWT
  signing secret, Telegram bot token, dashboard bootstrap secret all live in a
  gitignored `.env` with `chmod 600`. Never committed, never baked into images.
  - *Output:* `git ls-files | xargs grep` finds no live secret; the `.env`
    permissions are documented in the runbook.

### Local deployment posture

- **Bind policy.** Engine container publishes **no** host port; dashboard
  container publishes `127.0.0.1:<port>` only. Document the exact compose changes
  from M10's published-port defaults.
  - *Output:* `docker compose ps` shows no `0.0.0.0` bindings for the engine.
- **Backup job.** Nightly `pg_dump` to a local path **and** an offsite copy
  (rclone to a cheap object store such as Backblaze B2, or scp to a second
  machine). Weekly restore-test from the most recent dump into a throwaway
  container — an untested backup is not a backup.
  - *Output:* documented backup + restore procedure; last successful restore
    timestamp recorded in `RUNBOOK.md`.
- **Disk + retention sanity.** Confirm `tick_aggregates` partition rollover
  (M2/M8 W0) prunes old partitions; bound `decisions`, `account_snapshots`,
  `audit_events`, and Telegram-alert log growth for a multi-week soak on a
  laptop-class disk. Add a documented retention policy and, if needed, a small
  pruning job.
  - *Output:* projected disk growth over 60 days fits comfortably on the host;
    retention policy in `RUNBOOK.md`.
- **Host hardening.** Full-disk encryption on, OS auto-updates on, SSH key-only
  (no password), unattended-upgrades for security patches, host firewall denies
  inbound by default.
  - *Output:* a one-page host-setup checklist in `RUNBOOK.md`.
- **Remote access.** If the dashboard must be reachable away from home, the only
  supported path is a private mesh tunnel (Tailscale / WireGuard). No
  port-forwarding on the home router.
  - *Output:* documented tunnel setup; verified the dashboard is unreachable
    from a public-internet IP scan.
- **Power + network resilience.** UPS sized for ≥10 min runtime to ride out
  brief outages and trigger graceful shutdown via NUT or apcupsd. Document
  expected behavior on full power loss (engine restarts, crash-recovery pipeline
  rebuilds state from Postgres + exchange).
  - *Output:* a power-loss drill executed once; recovery time recorded.

### Soak operations

- **Soak runbook.** What the operator checks daily; which Telegram alerts mean
  "look now" vs "look tomorrow"; how to snapshot Postgres for a post-mortem on a
  surprising trade; how to halt + drain + resume; how to roll a strategy version
  back; key-compromise / token-rotation procedure.
  - *Output:* `RUNBOOK.md` covering start/stop, halt, recover-from-crash,
    incident steps, key rotation, and the daily checklist.
- **Crash-recovery drill.** Execute the M6 W8 ten-phase crash-recovery pipeline
  end-to-end on the local box: `docker compose down` mid-position, restart, and
  verify the position, protective orders, and reservation ledger reconcile
  against Binance demo state.
  - *Output:* documented drill result; any divergence becomes an M11a follow-up
    before the soak begins.
- **Restricted profile (demo-trading).** The first paper trader is the
  **restricted, exhaustion-confirmed v1** (v0 is the no-trade baseline; v3 is
  the deferred end-state target). Same profile applies later to live:

  ```json
  {
    "live_mode": "restricted",
    "max_open_positions": 1,
    "max_coin_tier": 1,
    "risk_per_trade_pct": 0.25,
    "allow_mean_reversion": true,
    "allow_momentum": false,
    "require_exhaustion_confirmation": true,
    "require_oi_available": true,
    "skip_fresh_universe_entrants": true,
    "skip_market_stress": true,
    "max_trades_per_day": 3,
    "halt_after_consecutive_losses": 2,
    "margin_mode": "isolated"
  }
  ```
  - *Output:* the documented restricted profile is committed as the soak config;
    no daily profit target.

### Carried pre-M11 deferred items (touched here because they block the soak)

Pulled forward from the pre-M11 deferred list because each one bites under a
multi-week run, not a five-minute smoke. The full list stays catalogued in
`CLAUDE.md`; items below are M11a-scoped.

- `risk_state.updated_at` true newer-wins (silent multi-instance drift becomes a
  real risk if the user ever runs two processes by accident).
- `LiveGateway` AppConfigService injection + parser parity test.
- `notePragmaticTransition` clamps + try-block order + `startOfRiskDayMs` init +
  `lastTransitionAuditId` JSDoc.
- Cache-Control on halt/history endpoints.
- pino-pretty dev-arg fallback (so a fresh `docker compose up` doesn't crash on
  missing pretty transport in production images).

Other deferred items (BaseRepository uuid-PK widening, AUTH token TTL comment,
strategy-comparison UI) explicitly **do not** block the soak and stay deferred.

## Soak exit criteria → M11b

The soak is the gate, not a deadline. M11b is entered only when:

- **≥30–60 days** of continuous demo-trading on the local box with no operator
  babysitting beyond the daily check.
- Realized slippage tracks the M7 backtest model within tolerance.
- Live expectancy is positive on the active version's restricted profile.
- Stop / protective-order behavior matches backtest.
- No unresolved crash-recovery or reconciliation incidents.
- The active version beats the v0 no-trade baseline on net risk-adjusted metrics
  (M8 promotion gate, applied to the soak window).

If those criteria fail, the next step is **not** M11b — it is iterating on the
strategy under M8's walk-forward / promotion workflow, still on demo, still at $0
infra. M11b only buys hosting; it does not improve the edge.

## Definition of done

The stack runs on a single trusted local machine against Binance demo trading,
with key-permission assertion, WS resilience, rate-limit guards, secrets in a
`chmod 600` `.env`, nightly backups + offsite + restore-tested, a bind policy
that exposes nothing to the public internet, a documented runbook covering
incidents and key rotation, the restricted v1 profile committed as soak config,
and a crash-recovery drill executed successfully. The soak is then runnable
hands-off for weeks at $0 infra cost.

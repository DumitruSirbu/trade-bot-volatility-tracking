# M11a — Local soak hardening

**Goal:** Make the existing stack production-grade on a single trusted machine so
the user can run a multi-week **Binance demo-trading** soak at $0 infra cost and
collect real signal on the strategies before any cloud spend.

**Depends on:** M1–M10.
**Follows into:** M11b (cloud go-live) — only entered once the soak confirms a
live edge worth paying ~$5–60/mo to host.

**Review baseline:** architect / devops / security / logic review completed
2026-05-25 against commit `4bfeab4`. All blocker + high findings are folded into
the waves below; medium / low findings are tracked in the per-task notes.

## Why split M11

The original M11 conflated two very different problems:

1. **Operate the bot safely on hardware you already own**, against Binance demo
   trading, for weeks, while you observe whether the strategies actually work.
2. **Move the same stack to a cloud with managed Postgres, private networking,
   secret manager, static egress IP, multi-instance, external reverse proxy.**

For an account sized $500–$1,000 with a target of survival over returns, paying
$30–60/mo in infra before there is *any* evidence of live edge is negative-EV.
The local soak is the gating experiment; the cloud topology is the prize you pay
for only if the experiment succeeds.

## Wave structure

M11a runs in explicit waves so cross-cutting contracts land before consumers,
matching the dispatch rules in `docs/best-practices/dev-qa-cycle.md`.

| Wave | Owner | Content |
|------|-------|---------|
| **W0** | `bot-shared-maintainer` (+ `bot-architect` for ADRs) | Shared contracts: `ExchangeEnvironmentEnum`, `IKeyPermissionSnapshot`, `IExchangeClient.fetchKeyPermissions()`, `ILiveModeProfile`, `LIVE_GO_AHEAD_TOKEN` config gate |
| **W1** | `bot-engine-nestjs` | Exchange & key safety, auth rotation, demo-trading client switch |
| **W2** | `bot-engine-nestjs` | M6 pre-go-live blockers (2.2.3 / 2.2.5 / 2.2.7) + soak-blocking pre-M11 deferred items |
| **W3** | `bot-devops` (+ `bot-scribe` for runbook) | Local deployment posture (bind policy, backups, retention, host hardening, runbook) |
| **W4** | main session (operator) | Soak start: restricted-profile commit, calibration day, crash-recovery drill, soak runs |

## W0 — Shared contracts (BLOCKING all other waves)

**Owner:** `bot-shared-maintainer`; ADRs by `bot-architect`.

The previous draft of M11a leaned on a binary `EXECUTION_MODE` plus the
`disableFuturesSandboxWarning` toggle to distinguish testnet from "live." That
shape cannot express demo trading and cannot enforce the demo→live invariant.

- **W0.1 — `ExchangeEnvironmentEnum`.** Add the enum
  `{ TESTNET, DEMO, LIVE }` to `packages/shared/`, replace every existing
  testnet/live branch in engine config, exchange clients, and execution policies
  to switch on it, and add a config-loader validation that:
  - rejects an unset value (no silent defaults);
  - requires `EXCHANGE_ENV=LIVE` to be paired with a separate `LIVE_GO_AHEAD_TOKEN`
    file whose hash matches a value baked into config at build time;
  - emits a loud Telegram alert at boot containing the resolved env + API-key
    fingerprint (first/last 4 chars of the public key only — never the secret).
  - *Output:* every place that previously branched on testnet/live now reads the
    enum; `EXCHANGE_ENV=LIVE` cannot boot from a config edit alone.
- **W0.2 — `IKeyPermissionSnapshot` + `IExchangeClient.fetchKeyPermissions()`.**
  Define the shared shape returned by the assertion query. Snapshot must
  include: `enableReading`, `enableFutures`, `enableSpot`, `enableWithdrawals`,
  `enableInternalTransfer`, `permitsUniversalTransfer`, `enableMargin`,
  `enableVanillaOptions`, `enableSubAccountManagement`, `ipRestrict`,
  `ipAllowList`, `tradingAuthorityExpirationTime`. Add a small ADR documenting
  which ccxt path (`sapiGetAccountApiRestrictions` for spot vs futures-private
  endpoints) returns each field — ccxt does **not** uniformly surface Binance
  futures restrictions, so this is an explicit port, not a unified-method call.
  - *Output:* a documented port that lets W1 implement the assertion without
    hand-rolling `privateGet*` calls inside `CcxtBinanceExchangeClient`.
- **W0.3 — `ILiveModeProfile`.** Promote the restricted-profile JSON (currently
  inline) to a shared schema so config and runtime cannot drift. Validate at
  boot via Zod.
  - *Output:* the restricted profile is a typed contract; field renames cause
    compile errors, not silent drift.
- **W0.4 — `EXCHANGE_NOT_IN_DB` reconciliation event shape.** Cited by M6 W4b
  but never elevated to shared package; needed for the abort-threshold logic in
  W4. Add the event to shared.
  - *Output:* the soak runbook can listen for this event by typed name.
- **W0.5 — Shadow-decisions contract.** W4.2 routes v0/v2/v3 over the same
  `event_id` tape that v1 sees but never executes them. The recording shape
  must land in W0 so W4 has nothing left to design. Pick **one** in the plan
  now (rejecting the other two with one line of rationale):
  1. **New `shadow_decisions` table.** Owned by the decisions module, columns
     mirror `decisions` plus `shadow_version`, `virtual_slot_state_snapshot`,
     `simulated_fill` (jsonb, see W0.6). **Recommended** — keeps the
     high-volume `decisions` table free of nullable shadow-only columns and
     avoids retention-policy collisions with real decisions.
  2. Add `shadow_version` + `executed` to `decisions`. Rejected: pollutes the
     hot table and forces every existing query to filter on `executed=true`.
  3. Sidecar JSONL log file. Rejected: untyped, not queryable from the read
     API, fails the "criteria must be measurable from recorded data" rule.
  - *Output:* migration + repository + entity for `shadow_decisions` landed in
    W0; downstream waves consume the typed contract.
- **W0.6 — Shadow counterfactual + fill-simulator contract.** Two independent
  reviewers flagged that shadow comparison is statistically unsound without
  these two pieces. Define both in W0 so W4.2 is fully specified:
  1. **Independent virtual slot ledgers per shadow version.** Each shadow
     version maintains its own `IVirtualPositionLedger` honouring the same
     restricted-profile gates (`max_open_positions: 1`, `halt_after_consecutive_losses: 2`,
     `max_trades_per_day: 3`, exhaustion-confirmation, market-stress skip).
     A shadow version is **not** filtered by v1's slot state — it is filtered
     by its **own** ledger evaluated against the same event tape. This is the
     counterfactual: "what would version X have decided with its own state at
     this event."
  2. **Shadow decisions are scored by replaying through the M7
     `BacktestRunnerService` fill simulator** (tier slippage + latency +
     missed-fill + intra-bar stops) before any comparison metric is computed.
     Raw "if it had filled at decision price" PnL is **forbidden** as a
     comparison input — it ignores adverse selection, partial fills, and
     spread, and would trivially beat v1's realised PnL by construction. An
     ADR captures the rule.
  - *Output:* `IVirtualPositionLedger` interface in shared, ADR locking the
    counterfactual + fill-simulator pipeline; W4.2 references both by name.
- **W0.7 — `risk_state.updated_at` server-side timestamp migration.** W2.4
  consumes a true server-side `updated_at` (`DEFAULT now() ON UPDATE`); verify
  the column shape today, and if it is derived (TypeORM `@UpdateDateColumn`
  client-side) rather than server-set, the migration belongs here in W0, not
  in the W2 consumer wave. Skip this task entirely if the column is already
  server-side; document the verification either way.
  - *Output:* the W2 consumer fix lands against a contract that already
    enforces newer-wins at the database, not at the application layer.

## W1 — Exchange & key safety + auth rotation

**Owner:** `bot-engine-nestjs`. Consumes W0 contracts.

### Exchange

- **W1.1 — Binance demo-trading migration.** Switch `CcxtBinanceExchangeClient`
  off `testnet.binancefuture.com` and onto Binance demo trading (paper fills
  against live order books). Document the API-key procurement steps in the
  runbook (W3). Retire the testnet path or keep it behind
  `EXCHANGE_ENV=TESTNET` for regression only.
  - *Output:* engine places paper orders against live order-book depth.
- **W1.2 — Startup key-permission assertion (allowlist semantics).** Implement
  `verifyKeyPermissionsOrAbort()` on engine boot. **Allowlist, not denylist:**
  abort startup unless the snapshot is exactly `{ enableReading: true,
  enableFutures: true }` and **every** other capability flag is false. In
  addition, abort if `ipRestrict !== true`, `ipAllowList` is empty, or
  `tradingAuthorityExpirationTime` is in the past or unset. Behaviour is
  identical for DEMO and LIVE keys (TESTNET is exempt because Binance does not
  surface restrictions on testnet keys; the exemption is logged loudly).
  - *Output:* a key with any extra scope (withdraw, internal transfer, margin,
    sub-account control, options, universal transfer) prevents the engine from
    starting; an empty IP allow-list does the same; an expired
    trading-authority does the same.
- **W1.3 — WebSocket resilience verification.** Reconnect-with-backoff already
  exists (M1 `MarketDataModule` + M6 W2 `SubscriptionRetainer`). The M11a task
  is to **verify under simulated 10-minute drop**, confirm the existing Telegram
  alert fires on stall detection, and write the verification into the soak
  runbook. No new code expected unless the verification surfaces a gap.
  - *Output:* documented drill result; any gap raised becomes a follow-up.
- **W1.4 — Rate-limit guards (ADR + implementation).** ccxt's `enableRateLimit`
  does not express Binance's per-IP / per-UID / per-symbol order-weight
  classes. Architect ADR defines the in-engine token-bucket policy (one bucket
  per weight class); engine implements + wires reconciliation polling and
  funding poll through it.
  - *Output:* no rate-limit bans under burst conditions; ADR committed.

### Auth rotation (pre-M11 deferred items pulled in)

These bite under a multi-week run, not a 10-minute smoke:

- **W1.5 — `AuthFailureReasonEnum.BAD_SIGNATURE` split.** Separate signature
  failures from other auth failures in audit + metrics + Telegram alerts.
- **W1.6 — `revoked_jti` TTL prune + age-floor.** Scheduled prune so the table
  stays bounded; floor so a still-valid JWT cannot out-live its revocation
  entry. ADR clarifies the relationship between prune TTL and JWT lifetime.
- **W1.7 — HKDF cursor sub-key derivation.** Separate keys for cursor encryption
  and auth signing.
- **W1.8 — Bootstrap-secret rotation procedure.** Procedure (no code if it's
  config-only) for rotating the ADR 0027 bootstrap secret without operator-
  visible downtime. The soak runbook (W3) schedules at least one rotation in
  the soak window so the path is exercised, not just implemented.
- **W1.9 — Login rate-limiter state persistence.** Currently in-memory; an
  engine restart re-opens a brute-force window. Persist to Postgres (cheapest
  path; Redis is already in compose but the limiter does not currently use it).
  - *Output:* a restart preserves lockout counters; documented test.
- **W1.10 — `TRUSTED_PROXY_HOPS=0` pinned in `.env.example` + parity test.**
  M10 added XFF spoof rejection; once M11b adds an external reverse proxy this
  regresses silently. Pin the value to `0` for M11a (no external proxy) and add
  an integration test that fails CI if the limiter ever trusts an untrusted hop
  at this setting.

### Telegram redaction

- **W1.11 — Telegram + log redaction sweep.** pino redact must cover
  `*.telegram.token` and `req.url` for `api.telegram.org`; the alert formatter
  uses a field whitelist, not a blacklist. Verify error payloads on retry
  cannot leak the bot token in the URL path.
  - *Output:* documented redaction rules + a test asserting a synthetic payload
    cannot exfiltrate the token.

## W2 — M6 pre-go-live blockers + remaining soak-blocking items

**Owner:** `bot-engine-nestjs`.

These were left open at M6 close and labelled "M7 validation before M8 live."
The soak **is** the live validation, so they must land before W4 starts.

- **W2.1 — M6 blocker 2.2.3: exposure clamp-at-zero silent.** Add the alert
  + correctness fix so a clamp event surfaces in Telegram and audit.
- **W2.2 — M6 blocker 2.2.5: adoption slot-A misallocation.** Fix the slot
  selector so reconciliation-driven adoption picks the correct slot.
- **W2.3 — M6 blocker 2.2.7: `setOpenExposureFromBoot` post-boot guard.**
  Guard against post-boot calls that would overwrite live state.
- **W2.4 — `risk_state.updated_at` true newer-wins.** Rationale: the M9 R2
  crash-recovery race between bootstrap restore and a still-running write,
  *not* multi-instance (M11a explicitly excludes multi-instance — that is
  M11b). Fix the timestamp source so tie-break is deterministic.
- **W2.5 — `LiveGateway` AppConfigService injection + parser parity test.**
- **W2.6 — `notePragmaticTransition` cleanups.** Clamps + try-block ordering +
  `startOfRiskDayMs` init + `lastTransitionAuditId` JSDoc.
- **W2.7 — Cache-Control on halt/history endpoints.**
- **W2.8 — AUTH token TTL comment.** One-line edit adjacent to W1.5 work;
  pulled forward from the deferred list because it lives next to BAD_SIGNATURE.
- **W2.9 — pino-pretty dev-arg fallback (engine-side).** Detect missing pretty
  transport at logger init and fall back to JSON with a warning; the Dockerfile
  forced-flag can then drop. Defence in depth so a prod image accidentally
  booted with `NODE_ENV=development` does not crash.

Other pre-M11 deferred items (BaseRepository uuid-PK widening,
strategy-comparison UI) are **not** soak-blocking and remain deferred.

## W3 — Local deployment posture

**Owner:** `bot-devops` (compose, Dockerfile, healthchecks); `bot-scribe`
authors `RUNBOOK.md`.

### Compose changes (concrete, file:line)

The current `docker-compose.yml` publishes engine, dashboard, adminer, and
postgres on `0.0.0.0`, contradicting the bind policy. W3 lands all of:

- **W3.1 — Engine bind.** `docker-compose.yml:90-93` — replace
  `ports: ["${ENGINE_PORT:-3000}:3000"]` with `expose: ["3000"]`. The dashboard
  reaches the engine over the compose network; the container HEALTHCHECK runs
  inside the container and is unaffected. Document host-side debugging via
  `docker compose exec engine wget -qO- localhost:3000/v1/health`.
- **W3.2 — Dashboard bind.** `docker-compose.yml:112-113` — prefix with
  `127.0.0.1:` so it is not reachable from LAN/Wi-Fi peers.
- **W3.3 — Postgres bind.** `docker-compose.yml:15-16` — prefix with
  `127.0.0.1:` (or drop the host mapping entirely; engine reaches DB on the
  compose network).
- **W3.4 — Adminer bind.** `docker-compose.yml:128-129` — same prefix; the
  service is already behind a dev profile, this is defence in depth.
- **W3.5 — Engine network topology.** Two-network shape — flagged independently
  by architect + devops + security as a "soak won't boot" bug if implemented
  as a single `internal: true` network:
  - `backend` network with `internal: true` — postgres + redis only. No
    external egress; no other container can reach them.
  - default bridge network (`internal: false`) — engine + dashboard. Engine
    needs outbound TLS to `fapi.binance.com` and `api.telegram.org` plus
    external DNS; `internal: true` would break trading.
  - **Engine attaches to both networks**, postgres + redis attach only to
    `backend`, dashboard attaches only to the bridge.
  - Host loopback exposes only the dashboard's nginx (W3.2).
  - Daemon-level `icc=false` is a host-hardening item (W3.12), not a compose
    change.
- **W3.6 — Graceful shutdown + core-dump suppression.** `stop_grace_period: 30s`
  on the engine so SIGTERM has time to close WS, cancel in-flight orders, and
  flush `FillAccumulator`. Verify NestJS `enableShutdownHooks` is on. Add a
  small `docker-entrypoint.sh` that runs `ulimit -c 0` then `exec node
  dist/main.js`; update the Dockerfile to use it as `ENTRYPOINT`. Optionally
  call `prctl(PR_SET_DUMPABLE, 0)` via a tiny native shim or process-level
  setting for defence in depth.

  **Not in scope:** in-process API-secret zeroing. JavaScript strings are
  immutable and V8 retains copies in interning + the compiled-code cache; a
  `Buffer.fill(0)` on a value derived from a string only wipes a downstream
  copy, not the originals. The combination of `ulimit -c 0`, encrypted swap
  (W3.12), and `PR_SET_DUMPABLE=0` is the real protection. Document
  explicitly that in-process secret scrubbing is **not** a goal so the
  implementer does not ship security theatre.
- **W3.7 — `start_period: 60s`** on the engine healthcheck so the M6 10-phase
  crash-recovery cold start does not flap.
- **W3.8 — `env_file:` only.** Audit `docker-compose.yml` for any
  `environment:` block inlining a secret; convert all secret-bearing values to
  `env_file: [.env]` so `docker inspect` / `docker compose config` cannot
  print them.

### Backups

- **W3.9 — Backup + restore sidecars.** Add two compose profiles. Note that
  `postgres:18.4-alpine` has neither `age` nor `rclone` — bake a small custom
  image (`FROM postgres:18.4-alpine; RUN apk add --no-cache age rclone`) and
  pin it in the compose file.
  - `profiles: [backup]` — runs
    `pg_dump -h postgres … | gzip | age -r <pubkey> | rclone rcat b2:bucket/path`.
    Driven by host-cron `0 3 * * * docker compose --profile backup run --rm pgbackup`.
  - `profiles: [restore-test]` — spins a throwaway postgres + `pg_restore`
    from the latest dump and asserts row counts on `decisions`, `positions`,
    `audit_events`. Host-cron weekly.

  **`age` key custody (mandatory):**
  - **Public key committed in-tree** at `infra/backup/age-recipient.pub` so
    the recipient baked into the compose profile is tamper-evident under
    `git log` rather than hidden inside a gitignored file an attacker with
    `.env` write access could silently rotate.
  - **Private key on two independent hardware devices**, one offsite. A
    YubiKey + an offline encrypted USB on a separate physical site is the
    documented baseline. Loss of both is loss of the backups; document the
    recovery procedure (rotate to a new pubkey + re-encrypt the most recent
    on-host dump before the old pubkey is forgotten).
  - **Quarterly decrypt-drill** added to W4.3: pull the latest off-host
    dump, decrypt with the primary private key, restore into a throwaway
    container, assert row counts. A drill that has never restored from the
    *offsite* copy is not a tested backup.
  - *Output:* documented backup + restore procedure; key-custody section in
    `RUNBOOK.md`; last successful on-host + offsite restore timestamps
    recorded.

### Disk + retention

Per the devops review, sizing estimate: `decisions` ≈ 5–10M rows / 3–6 GB over
60 days at single-symbol ceiling; `account_snapshots` and `audit_events`
negligible; alert log unbounded under retry spikes; `tick_aggregates` already
has partition rollover (M2/M8 W0).

- **W3.10 — Retention SQL.**
  - `decisions`: prune `WHERE created_at < now() - interval '60 days'` (cron-
    driven via the backup-profile container).
  - `account_snapshots`: same window.
  - `audit_events`: **archive, not prune** — copy expired rows to a separate
    table or off-host archive before deletion. Security audit trail must be
    append-only for the soak window.
  - Telegram alert log: bound by row count (keep most recent N), not age.
  - Document projected disk growth in `RUNBOOK.md`.

### Host hardening + secrets

- **W3.11 — `.env` permissions.** `chmod 600 .env`; add `make check-env-perms`
  helper that fails if the file is group/world readable. `.env` is already
  gitignored (`.gitignore:25-28`).
- **W3.12 — Host hardening checklist.** Full-disk encryption (including
  swap — call this out explicitly because the SIGTERM handler relies on it);
  OS auto-updates; SSH key-only; unattended-upgrades for security patches;
  host firewall denies inbound by default; daemon `icc=false`; neutral
  hostname (no `tradebot.local` mDNS broadcast).
  - *Output:* one-page host-setup checklist in `RUNBOOK.md`.
- **W3.13 — Remote access via Tailscale.** `127.0.0.1` bind is unreachable
  from the tailnet by default. Mandated configuration:
  - `tailscale up --shields-up`;
  - `tailscale serve` proxying to the dashboard's `127.0.0.1:<port>`;
  - ACL restricting the dashboard port to the operator's own node;
  - `tailscale funnel=off`.
  Verification: nmap from a LAN peer **and** from a second tailnet node with
  the ACL applied; both must fail to reach the dashboard.
  - *Output:* documented tunnel setup + nmap verification; recorded in runbook.
- **W3.14 — Power + network resilience.** UPS sized for ≥10 min runtime,
  triggering graceful shutdown via NUT or apcupsd. Document expected behaviour
  on full power loss (engine restarts, M6 crash-recovery pipeline rebuilds
  state from Postgres + exchange). Drill once; record recovery time.

### Runbook

- **W3.15 — `docs/operations/RUNBOOK.md`** (fixed path so the scribe does not
  create duplicates) covering:
  - daily check (what to look at in dashboard + Telegram);
  - which alerts are "look now" vs "look tomorrow";
  - halt + drain + resume;
  - strategy-version rollback;
  - **key-compromise / token-rotation procedure** (suspected leaked exchange
    key or API token);
  - **bootstrap-secret rotation procedure** (W1.8);
  - **soak abort triggers** (see W4);
  - **demo → live transition checklist** (the two-token boot procedure from
    W0.1);
  - "do not run `docker compose config` outside a redirected shell" rule
    (renders interpolated env to stdout).

## W4 — Soak operations

**Owner:** main session (operator); `bot-engine-nestjs` only if a drill surfaces
a code gap.

- **W4.1 — Restricted v1 profile committed as soak config.**

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
  - `risk_per_trade_pct` is in **percent** (0.25 = 0.25% of account equity).
  - Validated against `ILiveModeProfile` (W0.3) at boot.
  - No daily profit target.

- **W4.2 — Shadow-mode dry-run for v0/v2/v3 over the soak window.** v0 is
  no-trade by definition, so the M8 paired-bootstrap CI has no v0 outcome
  series to resample against v1. To produce a meaningful comparison without
  routing v2/v3 to the exchange, run them in **shadow mode** over the same
  `event_id` tape v1 sees — strategies emit decisions, the orchestrator
  records them into the `shadow_decisions` table from **W0.5**, and the
  soak-evaluation tool reads them like a backtest.

  Two contracts from W0 are load-bearing here; the comparison metric is
  invalid without both:
  1. **Independent virtual slot ledgers per shadow version** (W0.6.1). Each
     shadow version is gated by its **own** `IVirtualPositionLedger`, not by
     v1's slot state. A shadow version decides on every event using its own
     restricted-profile gates; this is the only counterfactual that produces
     a fair comparison.
  2. **Shadow decisions are scored by replaying through the M7
     `BacktestRunnerService` fill simulator** (W0.6.2). Raw "filled at
     decision price" PnL is forbidden — it ignores adverse selection,
     partial fills, latency, and spread that v1 actually pays, and would
     trivially beat v1 by construction.

  The "active version beats shadow v2/v3" soak exit criterion (below) is
  **suspended** if either W0.6 contract is missing at soak-start; the soak
  still runs but the comparison is downgraded to "expectancy CI excludes
  zero on v1 alone" until both ledgers + fill-simulator pipeline are in
  place.
  - *Output:* `shadow_decisions` rows for each non-executed version over
    the soak window, each carrying a simulated-fill record from the M7
    fill simulator; the soak-evaluation tool produces per-version
    expectancy + per-regime metrics + paired-bootstrap CIs on the
    differences.

- **W4.3 — Crash-recovery drill — recurring.** Three scenarios, executed once
  before soak start **and** monthly during the soak, **and** after any auth
  secret rotation or config change touching M6 ADR-0014 phase 1 reads:
  1. Engine `SIGKILL` mid-fill — verify position, protective orders,
     reservation ledger reconcile against Binance demo state on restart.
  2. Postgres restart with engine running — verify the engine reconnects and
     state is consistent.
  3. Binance WS drop exceeding the reconnect-backoff ceiling — verify the
     stall alert fires and the engine recovers without operator action.
  Each drill verifies the W2.1/W2.2/W2.3 fixes did not regress (zero-clamp
  alert fires, slot adoption is correct, post-boot guard rejects writes).

- **W4.4 — Calibration day.** Before the soak proper begins, record 24h of
  growth on `decisions`, `tick_aggregates`, `account_snapshots`,
  `audit_events`, Telegram alert log, and project × 60 days. If the projection
  exceeds host disk headroom, adjust retention in W3.10 and re-measure.

- **W4.5 — Soak runbook dry-run.** Operator executes the runbook's daily check
  + halt + drain + rollback + key-rotation procedures against a test fixture
  before the soak proper starts. Catches doc drift before it bites in an
  incident.

## Soak exit criteria → M11b

The soak is the gate, not a deadline. M11b is entered only when **all** of the
following hold:

- **Duration: 45-day minimum, 60-day target.** Stop at 45 only if every other
  criterion is comfortably met; otherwise run to 60.

- **Minimum trade count: ≥80 closed trades.** Below this floor, statistical
  comparison is uninformative and the soak extends (not fails). Justification:
  with `max_trades_per_day: 3`, `halt_after_consecutive_losses: 2`, and
  exhaustion-confirmation gating, the M9 10h smoke saw 0 fills on 14
  candidates; ≥80 trades is roughly the minimum to detect a 2-sigma
  expectancy difference at the restricted profile's variance and is a
  documented relaxation of M8's ≥200-trade floor for this specific soak-window
  evaluation.

- **Reduced evaluation gate (soak-specific, documented).** M8's full
  12-criterion all-of promotion gate cannot run because v0 has no per-event
  outcome distribution. The soak-specific reduced gate evaluates v1 (executed)
  against shadow v2/v3 (W4.2) and against the v0 no-trade null hypothesis:
  - **Net positive expectancy** on v1's executed trades after fees + funding +
    realised slippage, with bootstrap 95% CI excluding zero (paired
    circular-block on v1's own trade tape; no v0 series required).
  - **Stop / protective-order behaviour matches the M6 model** (compare
    `stop_gap_pct` + `protective_order_type` distributions to backtest).
  - **No unresolved reconciliation drift events** — defined as zero
    `IReconciliationDriftDetectedEvent` without a paired
    `IReconciliationResolvedEvent` within TTL, and zero `UNRESOLVED_TTL`
    outcomes.
  - **No unresolved crash-recovery incidents** — every drill in W4.3 passed.
  - **Successful drill in the last 30 days** — recency requirement.
  - **Active version beats v0 baseline:** v1's risk-adjusted return is
    strictly positive (v0 returns zero; the test is whether v1's CI excludes
    zero from above).
  - **Active version beats shadow v2/v3** on net risk-adjusted metrics, per
    M8's per-regime metrics applied to the shadow tape.
  - **Auth rotation exercised**: at least one bootstrap-secret rotation +
    one JWT-signing-secret rotation completed during the soak with no
    operator-visible downtime, and `revoked_jti` stayed bounded.

- **Realized slippage recorded and recalibrated.** This is **not** a pass/fail
  criterion because M7's tier model was tuned on testnet's synthetic books;
  demo trading uses live order books with paper fills, so divergence ≠ broken
  strategy. Instead: realised slippage is recorded against the M7 model and a
  divergence outside ±50% triggers a tier-model recalibration task (folded
  into the M8 deferred depth-aware extension), not a soak failure.

- **No operator-visible halt-spam.** The soak should not require daily manual
  intervention beyond the documented daily check.

### Soak abort thresholds (stop-now triggers)

Independent of the exit criteria — hitting any of these aborts the soak and
routes to M8 strategy iteration, not extension:

- Paper-account drawdown ≥ 15%.
- Any unrecovered crash-recovery incident (drill or live).
- ≥ 3 unresolved `IReconciliationDriftDetectedEvent` in any 7-day window.
- Any `EXCHANGE_NOT_IN_DB` reconciliation event the bot did not raise.
- Any boot-time key-permission assertion failure that required operator
  override (i.e., the assertion was disabled to keep trading — never do this;
  abort the soak instead).

If exit criteria fail without an abort trigger firing, the next step is **not**
M11b — it is iterating on the strategy under M8's walk-forward / promotion
workflow, still on demo, still at $0 infra. M11b only buys hosting; it does not
improve the edge.

## Definition of done

The stack runs on a single trusted local machine against Binance demo trading,
with:

- W0 shared contracts landed (`ExchangeEnvironmentEnum`, key-permission port,
  `ILiveModeProfile`, two-token live-mode boot);
- key-permission assertion enforces an **allowlist** of exactly
  `{ enableReading, enableFutures }` plus non-empty IP allow-list and a
  non-expired trading authority;
- WS resilience verified under simulated drop, rate-limit guard policy
  implemented, demo-trading migration complete;
- auth rotation items landed and **exercised** during the soak;
- M6 pre-go-live blockers (2.2.3 / 2.2.5 / 2.2.7) fixed and verified by W4.3
  drills;
- no `0.0.0.0` bindings; engine on an internal docker network;
- nightly encrypted-at-source backups + offsite + weekly restore-test passing;
- retention enforced for `decisions` / `account_snapshots` / Telegram log;
  `audit_events` archived;
- `RUNBOOK.md` covering daily check, incidents, key rotation, bootstrap-secret
  rotation, soak abort triggers, demo→live transition;
- restricted v1 profile committed via `ILiveModeProfile`, shadow v2/v3
  recording decisions for comparison;
- soak completed with all reduced-gate exit criteria met **or** the soak
  routed back to M8 because criteria failed without abort, **or** an abort
  trigger fired and the soak was halted.

Only on full pass does M11b begin.

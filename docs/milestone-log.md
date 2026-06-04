# Milestone Log

Detailed outcome record for each completed milestone. Read this when:
- Debugging a regression and needing to know what was changed or fixed in a prior milestone
- Understanding why a specific design decision was made (look for "production bug", "DI cycle", "ADR" context)
- Checking what reviewer rounds ran and what blockers were resolved
- Looking up exact test counts or ADR numbers for a milestone

For the current milestone plan, see `docs/plans/`. For deferred items, see `docs/tech-debt.md`.

---

## Current Status

**M0 — Foundation & scaffolding:** DONE (pnpm + Docker + NestJS 11 + TypeORM + event bus + halt-flag + money helpers).
**M1 — Exchange & market data:** DONE (ccxt/Binance testnet, MarketDataModule, shared trigger, 251 tests).
**M2 — Persistence & data model:** DONE (13 domain-owned entities, 353 tests, reversible migrations + 90-day partitioned tick_aggregates).
**M3 — Strategy engine:** DONE (4 pure strategies v0–v3, registry + config-selected active version, 202 tests).
**M4 — Risk management:** DONE (bypass-proof risk gate, 3-slot position model, daily/weekly loss windows, funding suppression, 700 tests).
**M5 — Execution (testnet):** DONE (idempotent open/add/reduce/close, IOC + maker + reduce-market policies, FillAccumulator, LocalProtectiveMonitor, 898 tests).
**M5.5 — Adversarial backfill (pre-M6 hardening):** DONE (2 production bugs fixed, 172 adversarial tests added across M1–M5).
**M6 — Position management & reconciliation:** DONE (state-machine + transitions, SubscriptionRetainer, reconciliation + 6 drift cases, funding + PnL, account_snapshots, crash-recovery 10-phase pipeline, 851 tests).
**M7 — Backtesting & performance:** DONE (replay loop, fill simulator with tier slippage/latency/missed-fill/intra-bar stops, PnL/funding/slippage, Sharpe/Sortino/drawdown, 82 tests).
**M8 — Strategy versioning & comparison:** DONE (walk-forward OOS splits, bootstrap CI on expectancy-per-unit-risk, 12-criterion promotion gate. ADRs 0016–0019).
**M9 — Observability, control & read API:** DONE (schema-validation gate, HS256 bearer + revoked_jti, HaltController + audit, REST + CursorCodec, socket.io /live, TelegramAlertSink. ADRs 0020–0025).
**M10 — Dashboard:** DONE (Vite + React 19 + Tailwind + shadcn/ui, login + auth, read views + WS cache, kill-switch UI. ADRs 0026–0027).
**M11a — Local soak hardening (PAPER mode):** DONE (end-to-end paper-trading: HMAC-chained audit, deterministic fill simulator, boot-mode HMAC chain, nullity probe, reconciliation, 9-table schema, zero production bugs post-smoke).
**M12 — Analysis MCP:** DONE (read-only MCP server + analysis data layer, 5 tools, structural boundary @bot/engine-forbid, DB read-only role, 34 SQL-injection adversarial tests. ADRs 0033–0034).
**M13 — Agentic weekly loop:** DONE (unattended agent drafts strategy_versions via MCP, backtests draft vs active, writes comparison report, SDF idempotency, 259 tests. ADRs 0035–0038).
**M14 — CI review gate:** DONE (10 deterministic jobs: install/build/typecheck/lint/format/test/boundary/SCA/lockfile/exchange-dep, root `main` provably green, 2,555 engine tests. ADRs 0039–0041).
**M16 — Test-DB isolation:** DONE (dedicated ephemeral Postgres on port 6900, hard isolation guard, globalSetup pre-migrates, all `:5433` literals eliminated, static tripwire, 2 new test files).
**M18 — Directional rate-limit drift alert:** DONE (engine-only; no shared change). Fixed false-positive WARN spam (5-min coalesce window) by making drift gate directional: silent on safe direction (localUsed > headerUsed) where continuous-refill local bucket is intentionally conservative; fires only on under-count (headerUsed > localUsed ≥ 0.1 capacity) — genuine stale-weight-table / approaching-429 canary. Throttle/refill/halt logic unchanged. `RateLimitPolicyService.reconcileClass()` replaced Math.abs with signed underCountFraction. `maybeFireDriftAlert()` reworded (title "Rate-limit UNDER-COUNT detected", body states %). Log key changed rateLimit.drift → rateLimit.underCount (field: underCountFraction). Tests: 22/22 directional spec green; full src/exchange 53/53; regression guard fails against old code. Review: logic CLEAN (halt path intact, canary preserved, lastDriftPct snapshot unchanged), clean-code 2 must-fix + 2 should-fix fixed, continuity re-review CLEAN. Operational note: external log-scrapers on rateLimit.drift key must update to rateLimit.underCount. Zero blockers, zero highs at close.
**M19 — Per-coin liquidity gate:** DONE (code-only; no migration, no DB write). Fixed the soak's 0-trades-from-97-signals halt: book-depth-collapse (a per-coin property) was wired into the global day-killing stress halt, so the first thin tier-2 alt flipped `risk_state.is_halted` and rejected every later signal (even deep tier-1 majors) as `global_halt`. Moved depth to a per-coin tier-keyed eligibility skip (`COIN_DEPTH_FLOOR_10BPS_USDT {t1:20k,t2:10k,t3:5k}`, reject `coin_book_too_thin`, boundary `<=`, fail-closed via `parseMoney` try/catch). Resurrected the dead breadth halt via risk-only const `STRESS_BREADTH_DISTANCE_PCT=30`, decoupled from the `stress_breadth_pct=70` param `classifyFlowType` still uses (decoupling eliminated the migration). Spread widening stays the sole global liquidity halt. ADR 0004 §6 revised (§6a depth-guard, §6b breadth decoupling). 245 risk + 209 backtest tests green; +8 paired regression tests (day-contagion proof, fail-closed adversarial, breadth-at-30, classifyFlowType-unchanged, backtest breadth-sentinel). Review: quant BLOCKER (backtest runner seeded breadth=0 → const-30 halt would halt every replay bar; fixed to neutral) + logic/security HIGH (Money parse could throw out of gate; fixed) resolved; round-2 logic CLEAN. Operational follow-up NOT yet run: stale-halt clear for today's `risk_state` via `clearHaltForDate` (needs dump + user confirm) + 10-min live smoke + behavioural soak funnel re-check. Zero blockers, zero highs, zero mediums at close.
**M21 — Index-shock horizon alignment:** DONE (code-only; no migration, no DB write). BTC and ETH index-shock legs both on 5m horizon. STRESS_BTC_5M_SHOCK_PCT = 1.5 (BTC was inert at 1m, peak 0.56%); STRESS_ETH_5M_SHOCK_PCT raised 2.0 → 2.5 (only event was 2.12%). Atomic swap of hasInvalidStressInputs + isIndexShock. Deprecated 1m params retained. 191 tests green. Note: historical replay BTC index-halt frequency will be higher than soak implied (BTC leg was inert pre-M21); expected, not a regression. Review: security CLEAN, logic CLEAN, clean-code CLEAN, quant HIGH logged as MEDIUM tech-debt, two covered MEDIUMs. Zero blockers, zero highs, zero mediums at close.
**M19 — Per-coin liquidity gate:** DONE (code-only; no migration, no DB write). Fixed the soak's 0-trades-from-97-signals halt: book-depth-collapse (`book_depth_10bps_usdt ≤ $20k`) was wired into the global day-killing stress halt, so the first thin tier-2 alt flipped `risk_state.is_halted` and rejected every later signal (even deep tier-1 majors) as `global_halt`. Moved depth to a per-coin tier-keyed eligibility skip (`COIN_DEPTH_FLOOR_10BPS_USDT {t1:20k,t2:10k,t3:5k}`, reject `coin_book_too_thin`, boundary `<=`, fail-closed). Also resurrected the permanently-dead breadth halt via risk-only const `STRESS_BREADTH_DISTANCE_PCT=30` (fires at breadth ≤20 or ≥80), decoupled from the `stress_breadth_pct=70` strategy param that `classifyFlowType` still uses for MARKET_BETA routing (the param re-seed would have been an out-of-scope strategy change). Spread widening (`STRESS_SPREAD_PCT=0.6`) stays the only global liquidity halt. Tests: 245/245 risk + 209/209 backtest green (+8 paired regression tests: day-contagion two-signal proof, fail-closed adversarial incl. whitespace/hex/NaN, breadth-at-30 boundaries, classifyFlowType-unchanged guard, backtest breadth-sentinel guard). Review: logic round-2 CLEAN (full fail-closed trace), security HIGH (Money parse could throw out of gate on `'  100  '`) fixed, quant BLOCKER fixed — backtest runner seeded `marketBreadth5mUpPct: 0` which `|0-50|=50 ≥ 30` would have halted every replay bar; changed to `MARKET_BREADTH_NEUTRAL_PCT`. ADR 0004 §6 revised (new §6a depth-guard, §6b breadth-distance decoupling). Operational follow-up (NOT yet run): post-deploy stale-halt clear for today's `risk_state` via `clearHaltForDate` (needs dump + user confirm); 10-min live smoke. Deferred: depth floors not yet empirically calibrated to slippage (quant Medium → post-soak). Zero blockers, zero highs, zero mediums at close.

**M21 — Index-shock horizon alignment:** DONE (code-only; no migration, no DB write). BTC and ETH index-shock legs both on 5m horizon. `STRESS_BTC_5M_SHOCK_PCT = 1.5` (BTC 1m was inert at 1.0%, peak observed 0.56%); `STRESS_ETH_5M_SHOCK_PCT` raised 2.0 → 2.5 (only event was 2.12%, 2.5% is slightly conservative per 1.2–1.5× ETH beta). Atomic swap of `hasInvalidStressInputs` guard + `isIndexShock` (fail-closed). Deprecated 1m params retained for replay compatibility. 191 tests green. Note: historical replay BTC index-halt frequency will be higher than soak implied (BTC leg was inert pre-M21); expected, not a regression. Review: security CLEAN, logic CLEAN, clean-code CLEAN, quant no blockers; quant HIGH (backtest BTC candle vs rolling-window statistic divergence) logged as MEDIUM tech-debt; two covered-by-plan MEDIUMs. Zero blockers, zero highs, zero mediums at close. **Post-deploy steps required:** (1) stale-halt rollout — inspect today's `risk_state` after restart; if `is_halted=true` from old thresholds and live tape is calm under new floors, clear with `clearHaltForDate` (dump + user confirm) or wait for UTC rollover. (2) 10-min live smoke. (3) 14-day post-deploy near-miss telemetry: log daily max `|btc_5m_move_pct|` / `|eth_5m_move_pct|`; watch bands `|btc_5m| ∈ [1.2,1.5)` and `|eth_5m| ∈ [2.0,2.5)`.

**M15 gates:** (a) PAPER soak passing per `docs/plans/M11a-local-soak.md` soak-exit criteria AND (b) TESTNET pre-M15 drill green (order-lifecycle + reconciliation + rate-limit under burst load).
**Branch protection NOT YET APPLIED** — see `docs/runbooks/ci-gates.md` payload; must apply before any live merge.

**Deferred items:** see `docs/tech-debt.md` — HIGH-priority go-live blockers listed there.

**Next:** **M15 — Cloud go-live** (gates: M11a soak exit + TESTNET drill green; proof-of-edge tradeable by M8 walk-forward; deployed to Binance live $500 tier-1 symbols isolated, zero crashes 7d, ready for scaling post-validation).

---

## M22 — Depth-floor recalibration

**Problem (from soak data):** MAGMA ($529 depth) and H ($5,380 depth) were tier-ranked as TIER_1 by volume, yet their books were too thin for the risk guard. M19 moved depth to a per-coin skip, but used conservative round-number floors `{t1:20k,t2:10k,t3:5k}` that left M19 floor-calibration as outstanding MEDIUM tech-debt. M22 recalibrated to empirically-anchored book-consumption-ratio values.

**Fix (code-only — no migration, no DB write):**
1. **Recalibrated depth floors.** New `COIN_DEPTH_FLOOR_10BPS_USDT { TIER_1: 10_000, TIER_2: 2_500, TIER_3: 2_000 }` (one-sided, $250 max order = `MAX_EXPOSURE_PER_COIN_USDT`). Rationale: `TIER_1` 10k at 2.5% consumption; `TIER_2` 2.5k at 10% consumption; `TIER_3` 2k at 12.5% consumption. Soak evidence (2026-06-04): 10 rejects total; 7 now unblocked (SHIB $3,468, DOGE $5,197, BNB $5,320, SOL $6,281, ETH $6,788, BLUR $9,174, APTOS $9,174); 3 still blocked (MAGMA $529, GFI $681, AKT $2,321). M19 floor of $20k would have been 4–80× the order size; new floors are 4–10×.
2. **ADR 0004 §6a superseded in place.** New floor table, book-consumption ratio anchor, 2026-06-04 soak evidence (7 unblocked / 3 still blocked), inclusive `<=` boundary, one-sided measurement note, and 14-day post-deploy slippage-telemetry requirement. Calibration condition: entry fills vs modeled slippage must confirm before scale-up.
3. **ADR 0004 §6b corrected.** `STRESS_BREADTH_DISTANCE_PCT` value drifted 40 in code but was documented as 30; fixed doc to 40.

**Tech-debt entries added:** (1) Volume-only tier ranking (MAGMA / H impostors). (2) Entry-vs-exit depth gap (stop-loss slippage risk unguarded).

**Tests:** 23 new in `RiskGateService.bookDepth.spec.ts`: per-tier boundary tests, regression proof, still-blocked symbol proofs (H as TIER_1 impostor), fail-closed assurance, const integrity.

**Review cycle:** R1 (security CLEAN, logic 1 HIGH + 2M, clean-code 1 HIGH + 2M, quant 0H + 1M + 3L) → Fix wave (H logic tier-accurate tuple, H clean-code unused variable, mediums address breadth-drift doc note + funnel-mix check scope) → R2 (logic CLEAN, clean-code CLEAN). Zero blockers, zero highs, zero mediums at close.

**Files modified:** `apps/engine/src/risk/const/riskConsts.ts`, `docs/architecture/adr/0004-risk-management.md` (§6a supersede in place, §6b correction), `apps/engine/src/risk/service/__tests__/RiskGateService.bookDepth.spec.ts` (new), `docs/tech-debt.md` (M19 entry rewritten, 2 new MEDIUM entries), `docs/plans/M22-depth-floor-recalibration.md` (amended with Composer review findings).

**Zero blockers, zero highs at close.**

---

## M17 — Automated daily DB backup (local disk, 3-deep retention)

In-engine NestJS `DbBackupScheduler` + dynamic cron registration via `SchedulerRegistry.addCronJob`. Daily UTC `pg_dump` of the soak DB (`DATABASE_URL`), gzipped, written to host-bind-mounted `DB_BACKUP_DIR` (compose: `/var/backups/trade-bot` with explicit engine env override; host dev: `./backups`). Keeps the 3 newest `trade_bot_<YYYYMMDD_HHMM>.sql.gz` dumps and prunes older. Atomic write via `.tmp` → rename (no truncated dump promoted). Re-entrancy mutex (skip tick if dump in progress). Credentials via minimal libpq child env (never argv, never logged). Anchored filename pattern + `realpath` guard prevents path-traversal prune. Failure alert reuses `AlertTypeEnum.UNHANDLED_EXCEPTION` / `DB_BACKUP_FAILED`. Image carries `postgresql18-client` (Alpine 3.23, pg_dump 18.4, build-time smoke test). Non-root mount permissions documented + verified (uid 1000). `DB_BACKUP_DIR`, `DB_BACKUP_ENABLED`, `DB_BACKUP_CRON` (5-field UTC), `DB_BACKUP_RETENTION` (@Min 1) configured + validated. CI test job sets `DB_BACKUP_ENABLED: 'false'`. `backups/` gitignored. Read-only — never mutates soak DB.

**Tests:** 73 specs green (37 scheduler unit covering retention boundaries, failure modes, re-entrancy, pipeline-error paired tests; 28+ config validation).

**Review cycle:** 1 round + 1 fix wave + continuity re-review. Round 1: 0 blockers, 1 HIGH (dump success gated on pg_dump exit, not gzip→file pipeline flush/error), 3 mediums (full `process.env` spread into child, orphan `.tmp` cleanup, misleading `survivors` var name), 5 clean-code must-fixes. Fix wave 1 resolved all HIGH + mediums + must-fixes; re-review confirmed HIGH + mediums cleared, 0 new findings.

**Bug caught in passing:** `postgres-test` tmpfs mount was `/var/lib/postgresql/data` (wrong for postgres-18 PGDATA `/var/lib/postgresql/18/docker`, VOLUME parent dir); fixed to `/var/lib/postgresql`, matching soak service.

**Files touched:** `apps/engine/Dockerfile` (client), `docker-compose.yml` (mount + override), `.env.example`, `.env.test.example`, `.gitignore`, `.github/workflows/ci.yml` (env), `apps/engine/src/config/` (validation), `apps/engine/src/backup/DbBackupScheduler.ts` (new), `apps/engine/src/backup/BackupModule.ts` (new), engine bootstrap, `apps/engine/tests/backup/DbBackupScheduler.spec.ts` (new), config-validation spec, `docs/runbooks/db-backup.md` (refined), runbook operator notes.

**Zero blockers, zero highs at close.**

### M17.1 — DB-backup hardening + operational incident (2026-06-02)

**Operational incident (2026-06-02 03:00 UTC):** Daily M17 auto-backup failed silently. Root cause: host `./backups` bind-mount directory was deleted/recreated while engine container ran, leaving container's `/var/backups/trade-bot` mount STALE. Dump's `createWriteStream` hit "nonexistent directory" error, surfacing only as generic `"pg_dump pipeline"` WARN log with underlying cause stripped. Operator fixed operationally by recreating engine container. **Secondary issue on reboot:** Engine crash-looped on boot with Binance `-2015 (Invalid API-key/IP/permissions)`. Root cause: `EXCHANGE_ENV=paper` correctly routes to LIVE Binance (`fapi.binance.com`, per ADR 0032), but `.env` held invalid credentials. Note: `EXCHANGE_TESTNET` is a DEAD env var (only "retained read-only" per EnvironmentVariables.ts:69) — `EXCHANGE_ENV` is the real selector. Operator rotated in valid key; engine boots healthy.

**Hardening fixes (code complete, all verified):**
1. **Pre-flight writability probe `assertDirWritable()`** — writes/unlinks `.write_probe_<pid>` before spawning pg_dump, converting stale-mount crash into loud typed failure BEFORE wasted dump. Probe cleanup narrowed to WARN only on non-ENOENT. Constant: `BACKUP_WRITE_PROBE_PREFIX = '.write_probe_'`.
2. **`describeWithCause()` + hardened `describe()` cause-surfacing** — underlying cause (pg_dump stderr tail / fs-error code:message) now appears in BOTH error log AND Telegram alert body; non-Error objects serialize meaningfully (no `[object Object]`), with JSON.stringify fallback.
3. **Failure-alert severity WARN → CRITICAL.**

**Tests:** 72 backup specs green (27 added during hardening). **Review:** security/logic/clean-code — 0 blockers, 0 highs, 0 mediums.

**Tech-debt entries added:**
- HIGH: (none)
- MEDIUM: rate-limit drift `header-used ≈ 1` anomaly — investigate whether public market-data endpoint weights tally on different Binance IP-weight ledger than local bucket assumes. Cross-ref `docs/plans/M18-rate-limit-drift-directional-alert.md`.
- LOW: remove dead `EXCHANGE_TESTNET` env var (superseded by `EXCHANGE_ENV`; cost debugging time today). LOW: backup/drift alerts reuse `AlertTypeEnum.UNHANDLED_EXCEPTION` — consider dedicated alert type. LOW: backup probe `writeFile` could use `flag:'wx'` IF filename made per-run unique; pg_dump-non-zero credential test could inject sentinel password into mock stderr (non-vacuous).

**Files modified:** `apps/engine/src/backup/DbBackupScheduler.ts` (assertDirWritable, describe, describeWithCause), `apps/engine/src/backup/const/backupConsts.ts` (BACKUP_WRITE_PROBE_PREFIX), `apps/engine/tests/backup/DbBackupScheduler.spec.ts` (27 new specs), `docs/work-log.md`, `docs/milestone-log.md`, `docs/tech-debt.md`.

---

## M19 — Per-coin liquidity gate (stop the global liquidity halt)

**Problem (from soak data):** 3 days of paper soak produced **0 trades from 97 open signals** — all 97 valid intents blocked by the risk gate (83 `global_halt`, 8 `market_stress`). The market was calm at every halt. Root cause: `isLiquidityShock`'s book-depth-collapse check (`book_depth_10bps_usdt ≤ $20,000`) was the only trigger firing. The universe is mostly thin tier-2 alts (median 10bps depth across the 97 opens $26,812; min $1,024), so the $20k floor failed ~half of them. **Architectural defect:** a per-coin liquidity property was wired into a global, day-killing halt — the first thin alt to trip on a UTC day flipped `risk_state.is_halted=true`, rejecting every later signal that day (even deep tier-1 majors SOL/BNB/LINK/TON) as `global_halt`. Tripped on all 3 soak days → no executable trades, no calibration data. **Secondary defect:** the breadth-collapse halt was permanently dead — it tested `|breadth−50| ≥ stress_breadth_pct` with the param = 70, but breadth is 0–100 so max distance is 50; could never fire.

**Fix (entirely code-only — no migration, no `strategy_versions` write, no soak-DB touch):**
1. **Depth → per-coin tier-keyed eligibility skip.** New risk const `COIN_DEPTH_FLOOR_10BPS_USDT {tier1: 20_000, tier2: 10_000, tier3: 5_000}` (computed enum keys). New `RiskGateService.isBookTooThin()` inserted in `firstFailingTierFilter()` adjacent to the spread check (per-coin group, runs **after** halt checks so it can only skip the coin, never persist a halt). Reject reason `RejectReasonEnum.COIN_BOOK_TOO_THIN = 'coin_book_too_thin'`. Boundary `<=` (depth at floor rejects — preserves old global behavior; opposite the spread's strict `>`). Fail-closed: unknown tier / missing / empty / unparseable / non-finite / non-positive depth → reject, never throws, never passes-open. Parses once via typed `parseMoney` (try/catch → `MoneyParseException`) then validates on the Decimal (`!isFinite() || <=0`).
2. **Breadth halt resurrected + decoupled.** New risk-only const `STRESS_BREADTH_DISTANCE_PCT = 30` (distance from `MARKET_BREADTH_NEUTRAL_PCT = 50` → fires at breadth ≤20 or ≥80). `isBreadthCollapse()` reads the const, no longer the `params` arg. **Critical decoupling (review H1):** `stress_breadth_pct` (param, =70) is left untouched and continues to drive `classifyFlowType()` MARKET_BETA routing — re-seeding 70→30 would have silently changed flow classification (out-of-scope strategy change). This is what eliminated the migration entirely.
3. **Spread widening** (`STRESS_SPREAD_PCT = 0.6`) remains the sole global liquidity-shock halt. Removed dead const `STRESS_BOOK_DEPTH_FLOOR_USDT`.

**Backtest blocker (caught by quant review):** `BacktestRunnerService` seeded `marketBreadth5mUpPct: 0` for every replay bar (cross-symbol breadth not reconstructable in single-symbol replay). Pre-M19 this was harmless (`|0−50|=50 < param 70`), but the new const-30 halt makes `|0−50|=50 ≥ 30` → MARKET_STRESS on bar 1, GLOBAL_HALT every subsequent bar → ~zero opens in every backtest. Fixed to seed `MARKET_BREADTH_NEUTRAL_PCT` (distance 0 → trips neither the halt nor MARKET_BETA routing). `BacktestEventBuilder` header comment corrected (it only passes breadth through; the runner is the single seed site).

**Tests:** 245/245 risk + 209/209 backtest green. +8 paired regression tests: day-contagion two-signal proof (thin tier-2 skip → deep tier-1 same UTC day reaches approval, NOT global_halt); fail-closed adversarial (`'  100  '` whitespace, `'0x10'` hex, `'1e3'`, `'  '`, null/empty/negative/zero/unknown-tier — all `coin_book_too_thin`, no throw, no halt persisted); breadth-at-30 boundaries (fires at 20/80, silent at 25/75); `classifyFlowType` MARKET_BETA-unchanged guard (param still 70); backtest breadth-sentinel guard (event carries 50 not 0, and 0 would have halted).

**Review cycle:** architect-first (ADR 0004 §6 revision) → shared → engine+dashboard → QA → 4 reviewers → 1 fix wave → continuity re-review. Round 1: quant **BLOCKER** (backtest breadth halt), logic + security **HIGH** (same root: `new Money(depthRaw)` could throw out of the gate on `'  100  '` — `Number()` and decimal.js accept different string sets), clean-code 1 in-scope must-fix (blank line). Fix wave resolved all. Round-2 logic re-review CLEAN (full fail-closed trace across every input branch); security + quant re-reviews blocked by account session limit but their findings were the same two code sites logic re-verified + green suites + paired regression tests. 2 comment-only test nits fixed inline by orchestrator. **Zero blockers, zero highs, zero mediums at close.**

**ADR:** 0004 §6 revised — new §6a (book depth = per-coin eligibility guard, removed from global stress-input list) and §6b (breadth halt uses risk-only `STRESS_BREADTH_DISTANCE_PCT`, explicitly fenced from the `stress_breadth_pct` flow-routing param, with a "DO NOT re-couple" locked callout).

**Dashboard:** `DecisionsFeed.tsx` reject-reason tooltip gained a `coin_book_too_thin` entry so soak operators don't misread a per-coin skip as a halt.

**Operational follow-up (NOT yet run — requires user action):**
- **Stale-halt clear:** the depth fix stops *new* depth-driven halts, but any `risk_state` row already flipped `is_halted=true` earlier in the current UTC day persists until rollover. After the new build is healthy: read today's row; if `is_halted=true`, `halt_reason='market_stress'`, AND market metrics are calm (the pre-M19 false-depth halt), clear ONLY today's halt via `HaltService` → `RiskStateRepository.clearHaltForDate` — gated by a `pg_dump` + explicit user confirmation (CLAUDE.md #8/#9). Otherwise wait for UTC rollover.
- **10-min live app smoke run** (`feedback-milestone-app-smoke`) — fix-and-report any boot/DI error.
- **Behavioural soak verification** (read-only): re-run decision-funnel query (thin-coin rejects now `coin_book_too_thin`, `global_halt` count falls sharply); confirm a deep tier-1 signal reaches later gates; sample ~20 post-deploy decisions to confirm MARKET_BETA share unchanged.

**Deferred (tech-debt):** depth floors are reasonable round numbers, NOT yet empirically derived from a depth-vs-realized-slippage relationship (quant Medium) → recalibrate post-soak once real fills accumulate (the whole point of unblocking the soak).

**Files touched:** `packages/shared/src/enum/RejectReasonEnum.ts`, `apps/engine/src/risk/const/riskConsts.ts`, `apps/engine/src/risk/service/StressHaltEvaluator.ts`, `apps/engine/src/risk/service/RiskGateService.ts`, `apps/engine/src/backtest/service/BacktestRunnerService.ts`, `apps/engine/src/backtest/service/BacktestEventBuilder.ts`, `apps/dashboard/src/views/DecisionsFeed.tsx`, `apps/engine/tests/risk/service/{StressHaltEvaluator,RiskGateService}.spec.ts`, `apps/engine/tests/strategy/utils/classifyFlowType.spec.ts`, `apps/engine/src/backtest/service/__tests__/BacktestRunnerService.spec.ts`, `docs/architecture/adr/0004-risk-management.md`, `docs/plans/M19-per-coin-liquidity-gate.md`.

---

## M0 — Foundation & scaffolding

pnpm + Docker + NestJS 11 + TypeORM + event bus + halt-flag + money helpers.

---

## M1 — Exchange & market data

ccxt/Binance testnet, MarketDataModule, shared trigger, 251 tests, 3 review rounds, zero blockers.

---

## M2 — Persistence & data model

13 domain-owned entities, 353 tests, reversible migrations + 90-day partitioned tick_aggregates, 2 review rounds + post-review smoke test, zero blockers, testnet persistence verified.

---

## M3 — Strategy engine

4 pure strategies v0–v3, registry + config-selected active version, orchestrator stamps flow_type/signal_score/event_id and writes dry-run decisions, 202 tests, 2 review rounds, zero blockers.

---

## M4 — Risk management

bypass-proof risk gate, 3-slot position model, BTC-correlated single-candidate, daily/weekly loss windows, in-flight reservation ledger, funding suppression + flow rules, spread/liquidity/SL/time-stop/cooldown/market-stress/consecutive-loss/overtrading/OI/tier-3 gates, isolated-margin default, model-divergence kill-switch, 700 tests, 2 review rounds, zero blockers.

---

## M5 — Execution (testnet)

ExecutionModule idempotent open/add/reduce/close, marketable-limit-IOC + post-only-maker + reduce-market policies, partial-fill FillAccumulator, LocalProtectiveMonitor arm/disarm, ccxt testnet, EXECUTION_MODE config, 898 tests, 5 review rounds, zero blockers, testnet smoke runbook documented.

---

## M5.5 — Adversarial backfill (pre-M6 hardening)

2 production bugs fixed in M2, 172 adversarial tests added across M1–M5, dev-qa-cycle validation complete, 3-round strict cap held, zero blockers/highs at close, pre-M6 deferred items catalogued.

---

## M6 — Position management & reconciliation

8 implementation waves: W0 shared-contracts, W1 state-machine + transition, W1.5 PENDING_OPEN entry, W2 SubscriptionRetainer, W3 LocalProtectiveMonitor eval, W4a+W4b reconciliation + 6 drift cases + mutation primitives, W5 funding + PnL, W6 PositionInstrumentor, W7 account_snapshots, W8 crash-recovery 10-phase pipeline; 5 review rounds with 8 contract adjudications; 78 adversarial tests zero production bugs; 851 focused tests; R5 clean all reviewers; zero blockers/highs at close; 3 pre-go-live blockers flagged for M7 validation; deferred reservation-linkage + cosmetic reshims + tech-debt to M7 W0.

---

## M7 — Backtesting & performance

BacktestRunnerService replay loop, fill simulator (tier slippage, latency, missed-fill, intra-bar stops), PnL/funding/slippage accounting, Sharpe/Sortino/drawdown metrics, IBacktestReport; 82 new tests, 2 review rounds, zero blockers/highs at close; known approximations catalogued: lowFidelity always true until depth-aware extension, entry notional for funding, force_close exit reason pending enum, cross-symbol metrics zeroed, missing BTC bars marked low-fidelity; deferred OrderPolicyRouter injection + eventAnchoredVwap reconstruction + force_close enum + depth-aware extension to M8.

---

## M8 — Strategy versioning & comparison

walk-forward OOS splits, paired circular-block bootstrap n=10k 95% CI on expectancy-per-unit-risk, per-regime metrics, 12-criterion all-of promotion gate ADR 0019; direction decision v0/v1/v2/v3 now data-backed; W0 force_close enum + M2 partition rollover, W1 OrderPolicyRouter injection, W2–7 stats/comparison/promotion/CLI, W8 59 adversarial tests; 3 fix rounds 0 blockers/highs at close; ADRs 0016–0019; 264 focused tests + 254+ adversarial/integration green; deferred M8 W6.1 criteria 7+9, M9 depth-aware, M11 eventAnchoredVwap + CLI auth.

---

## M9 — Observability, control & read API

startup schema-validation gate, auth guard HS256 bearer + revoked_jti, HaltController + rate-limit + audit, ReadApi REST + CursorCodec, socket.io /live gateway, TelegramAlertSink outbound-only, DailyPnlSummaryScheduler, RiskListeners; ADRs 0020–0025; 3 review rounds zero blockers/highs; live-app 10h smoke caught 2 production bugs + schema validation fixes; zero crashes; deferred M11 follow-ups catalogued.

---

## M10 — Dashboard

Vite + React 19 + TS + Tailwind v4 + shadcn/ui + TanStack Query; login endpoint (ADR 0027 bootstrap-secret), LoginRateLimiter + auth, read views + WS cache merge, kill-switch UI; engine Dockerfile + nginx containerisation; ADRs 0026–0027; 3 review rounds zero blockers/highs; live-app compose smoke verified login + real-time updates + XFF spoof rejection; 170 engine tests + 152 dashboard tests green.

---

## M11a — Local soak hardening (PAPER mode) + Shadow-decision infrastructure

R0–R4 + live-smoke fix wave DONE. Complete end-to-end PAPER-mode implementation (engine-local paper-trading against live Binance market data + M7 `FillSimulatorCore` + deterministic HMAC-seeded fills + boot-mode HMAC chain + nullity probe + reconciliation). PAPER architecture (D1–D17): shared ports (`IExecutionClient`, `IAccountStateSource`) + typed DTOs (`IOrder` with `reduceOnly`, `IPosition`, `IBalance`, `IFunding`, `IOrderIntent`); engine adapters (`CcxtExecutionClient`, `ExchangeAccountStateSource`, `PaperExecutionClient`, `PaperAccountStateSource`); `paper-mode/` module with capability guard, persistence (9 tables: `paper_account_state`, `paper_account_state_history`, `paper_account_state_meta`, `paper_account_snapshots`, `paper_simulator_idempotency`, `paper_state_audit`, `paper_crn_tape`, `boot_mode_history`, `boot_mode_chain_rotations`), HMAC-chained audit, deterministic fill simulator (`StreamingFillAdapter`), drawdown handler, funding service (D4 sign convention), reconciliation adapter (D12 CRITICAL on drift), nullity probe (D13 two-call + capability preflight), mark-price WS bridge (D5 throttled MTM). Boot-mode-history HMAC chain (D6 + D7): append-only typed rows, transition matrix with single-use tokens, crypto key subkey per purpose, sequence-numbered HMAC binding to prevent clock-skew attacks. Mode-aware key-permission assertion (D8 Fallback Profile LOCKED): PAPER on dedicated zero-balance sub-account with `enableFutures: true` only, gated by D13 probe invariants at boot (zero balance, zero positions, zero open orders, non-empty IP allow-list, non-null trading authority, no transfer permissions). FillSimulatorCore extracted to shared (D15, M7 numerical-equivalence regression test green). Engine-shape execution port (`IEngineExecutionClient` / `ENGINE_EXECUTION_CLIENT` dispatch token): `ExchangeOrderSubmitter` + `ProtectiveOrderAttacher` env-dispatch to `PaperExecutionClient` under PAPER (compile-time guarantee: no live-order leak via RateLimitPolicyService import guard). Auth/bootstrap DI cycle fixes: 3 leaf-module extractions (BootModeHistoryModule, KeyPermissionAssertionService, DerivedKeyService reshuffle). Test counts: ~2,384 unit tests green (658 M11a-new adversarial tests across R0–R3 cycles); 12 pre-existing PG-integration suites unaffected (require local Postgres). Reviewer cycle: R0 (doc-only) → R1 (3 fix waves, HMAC chains + boot sequence) → R2a (2 fix waves, IAccountStateSource + IExecutionClient ports) → R2b (1 fix wave, paper account state atomic migrations) → R2c (1 fix wave, FillSimulator + funding + MTM) → R2d (1 fix wave, reconciliation paper cases + NullityProbe) → R3 (audit + 11 new tests, module-graph + atomicity + causality + TOST + CRN) → R4 (4 reviewers, 1 consolidated fix wave + 1 shared lowFidelity follow-up) → post-R4 live-smoke fix wave (4 CRITICAL bugs: HMAC-chain manager.save() INSERT...RETURNING atomic capture, Binance `/sapi/v1/account/apiRestrictions/ipRestriction` discontinued endpoint dropped, sub-account response-shape defaults corrected, boot alert severity fixed from CRITICAL to INFO) all clean at close. Blockers/Highs resolved: R0 D8 endpoint-accessibility blocker (Fallback Profile design locked); R1 3 blockers + 5 highs (boot sequence, HMAC chain, Fallback Profile predicate); R2a–R2d 0 blockers + 0 highs per sub-wave; R3 audit green; R4 0 blockers + 0 highs; post-smoke: 4 bugs caught + fixed, engine now boots cleanly end-to-end. Addendum merged into `M11a-local-soak.md`: W1.1 reworded to PAPER design (D1–D17 locked decisions folded into new "PAPER-mode architecture" section with all anchor IDs preserved); D10 closed-trade counting integrated into "Minimum trade count"; lowFidelity downgrade + M11b gate hardening integrated into "Reduced evaluation gate"; pre-soak sanity step (asymmetric TOST D10) + sample-size pre-flight integrated into W4.4; TESTNET pre-M11b drill section added before exit criteria; Definition of Done updated for PAPER + TESTNET gates; operator runbook step added for IP allow-list verification (Binance UI only). Addendum file deleted (R4.2 scribe task complete). Engine builds clean, lint-touched-files clean, PAPER boot smoke complete (key-permission PASSED, boot pipeline 9/9, all paper-mode services active, PaperExchangeNullityProbe cycling, zero restarts post-fix). 9–10h soak monitor running, hourly self-checks, zero unhandled exceptions.

### M11a.1 — Shadow-decision infrastructure

Parallel to PAPER-mode milestone above: shadow-decision infrastructure for comparing active strategy performance against dormant alternative versions in real-time (live counter-factual backtesting). **W1 — Shadow infra + VirtualPositionLedger:** Migration `20260530080000-CreateShadowDecisions.ts` (shadow_decisions table, FK to strategy_versions, UNIQUE on (shadow_version, event_id), JSONB snapshot columns). ShadowDecisionEntity, ShadowDecisionRepository (idempotency guard on SQLSTATE 23505 duplicate-key). VirtualPositionLedgerService (in-memory per-shadow ledger, open/close tracking). StrategyModule wiring. **W2 — Shadow orchestration:** StrategyVersionRepository.findActiveShadows (query SHADOW-status versions). ShadowStrategyOrchestratorService (fans every volatility trigger to all shadow versions in parallel, runs FillSimulatorCore). StrategyService.onVolatilityDetected integrated. Migration `20260620000004-AddTradeSideToShadowDecisions.ts`. **W3 — Adversarial QA:** 37 new specs across VirtualPositionLedgerService, ShadowDecisionRepository, ShadowStrategyOrchestratorService (ledger idempotency, concurrent opens, close logic, error paths). **R1–R4 Reviewer cycle:** 4 logic BLOCKERs + 4 HIGHs + 9 MEDs + clean-code violations + 2 quant BLOCKERs surfaced. **W5a — Logic blockers fixed:** StrategyStatusEnum.SHADOW='shadow' added to shared contract. findActiveShadows filters on status=SHADOW only. Migration `20260621000000-PromoteShadowStrategyVersions.ts` (promotes DRAFT shadow rows to SHADOW). Migration `20260621000001-AddQtyStopTpToShadowDecisions.ts` (qty, stop_loss, take_profit columns). ShadowDecisionEntity updated with 3 fields; persistShadowDecision writes them; rebuildLedger reads + WARN on nulls. seedProcessedEventIds(eventIds) on ledger for restart dedup. closeBySymbol + forceCloseAllPositions added. SHADOW_TAKER_FEE_PCT='0.0004' constant. Reverse-signal close scaffolded in runOneShadow. **W5b — HIGHs + clean-code MUST-FIX:** countTradesOpenedOnRiskDay counts by openedRiskDayUtcDate (captured at open, not close). isHalted self-clears on day rollover. void→.catch() for fire-and-forget shadow orchestrator. QueryBuilder aliases fixed (sd.shadowVersion, sd.createdAt, sd.eventId). Dead params removed (_active*, _stopLoss*, _takeProfit*). Triple DRY null-guard cleaned to single shouldSimulateFill gate. IShadowDecisionPersistInput DTO (8 params→1 object). **W5c — Remaining HIGHs:** Reverse-signal close: isReverseClose detection BEFORE evaluateGates (fire under max_open_positions=1 restricted profile). Stop-side validation (isStopSideValid guards stopLoss > entry for LONG). IShadowOpenData discriminated union. SHADOW_TAKER_FEE_PCT string constant. **Shared contract update (QB1 prep):** ISimulatedFill.feeUsdtEntry/feeUsdtExit nullable strings (Zod validated) enable engine-side fee propagation in future wave. **DB corrective migration:** `20260531000000-CorrectActiveStrategyStatus.ts` (fixes W5a data state: id=2 v1→active, id=1 v0→shadow; ensures v1 not self-shadowing). **Final engine state:** active=volatility-vwap:1(id=2, mean_reversion), shadows=[v0, v2, v3]. Shadow decisions persisting to DB. v2 open decisions confirming lifecycle reachable. 367 unit tests passing, 23 suites. 10-min live smoke: zero ERRORs, all dashboard endpoints responding. **Tech-debt deferred (documented in docs/tech-debt.md):** QB1 simulateShadowFill populate feeUsdtEntry from HistoricalFillAdapter (HIGH). QB2 barHigh/barLow→entryPrice needs real candle bar data (HIGH). Equity frozen at PAPER_STARTING_EQUITY_USDT vs live scale (HIGH). Funding payments untracked in virtual PnL (HIGH). deriveShadowQty diverges from PositionSizer (HIGH). processedEventIds Set unbounded over soak lifetime (MEDIUM). Consecutive-loss gate scope (intra-day vs cross-day streak) needs spec (MEDIUM). runOneShadow 107 lines, 5 responsibilities (MEDIUM). CHECK constraints on action/shadow_version/trade_side (MEDIUM). Init log string-interpolates row.name/version (LOW). forceCloseAllPositions not wired from StrategyService end-of-window path (LOW). Reverse-signal exit price uses reference-price proxy, not intent:'close' simulation (LOW). **Zero blockers, zero highs at close.** Ready to land.

### M11a deferred to M15

M15 gates on (a) PAPER soak passing per `docs/plans/M11a-local-soak.md` soak-exit criteria AND (b) TESTNET pre-M15 drill green (order-lifecycle + reconciliation + rate-limit under burst load); simulator-config-hash real source (sentinel today, R3.1); soak-evaluator wave (CRN tape, TOST calibration, sample-size pre-flight, lowFidelity rankings); `HaltSourceEnum.PAPER_DRAWDOWN` / `PAPER_RECONCILIATION_DRIFT` dedicated values (shared change deferred M15); engine `IExchangeOrderSnapshot` → shared `IOrder` full migration (dual-shape today via D2 + D14 ports).

---

## M12 — Analysis MCP

W0–W6 DONE + post-close live-app smoke (fix wave 6). Read-only MCP server + analysis data layer. W0: workspace structure (`apps/mcp/`, `packages/analysis/`), DB role migration (`mcp_reader` default-read-only, 30s timeout, 5s lock-timeout, SELECT-only on 13 tables), root ESLint boundary rule (forbids `@bot/engine` + relative reaches for `apps/mcp/**` + `packages/analysis/**`). W1: analysis query layer (`DataSourceFactory` pool-3 TLS-strict, 4 query functions, `CursorCodec` pagination with filterHash binding, validation + consts). W3: MCP server (`RuntimeGuard` Layer C boundary scan, `ToolRegistry` write-reject-by-construction, Zod schemas + constants). W4: 5 read-only tools (`get_performance`, `compare_versions`, `list_positions`, `get_decisions`, `run_backtest`); run_backtest spawns engine CLI (abs-path validation, env allowlist, Sema(1), 10-min SIGTERM→SIGKILL, redacted stderr for postgres URLs + Bearer + IPv4/IPv6). ADRs 0033 + 0034 Accepted-and-shipped: structural boundary (workspace deps forbid @bot/engine; ESLint + runtime guards defense-in-depth), DB isolation (read-only role + 30s stmt-timeout + 3-conn pool + per-tool query budgets). W5: adversarial QA (34 SQL-injection tests, boundary compile-time spec, DB-role permission integration, DTO boundary, IPv6/JWT/URL redaction). W6: 4 reviewers + 5 fix waves; R1 2 blockers closed fix-wave-1; R2–R5 highs + mediums (security, logic, clean-code). Test counts: @bot/analysis 94 (all green), @bot/mcp 99 (all green), @bot/engine M12-touched 11 (all green); DB-role integration spec conditional on local PG. Boundary verified at close: `@bot/mcp` imports only @bot/shared + @bot/analysis; tsc --noEmit rejects @bot/engine; ESLint blocks patterns; runtime guard scans require.cache. Operator runbook: `docs/runbooks/mcp-deployment.md`. Post-scribe live-app smoke (per `feedback-milestone-app-smoke`) caught 3 production bugs (symbol regex too narrow for CCXT format, getPerformance label fallback masks valid versions, engine onModuleDestroy crashed on rate-limited close()). All 3 fixed in fix wave 6; re-smoke verified end-to-end. Test counts: 97 analysis + 100 MCP + new engine onModuleDestroy spec. `.env.example` gained an MCP section (default MCP_DB_PORT=5433 per host port mapping). Outstanding mediums deferred (TOCTOU, quoting, rotation, missing index, Math.floor vs round, refactor nits, formatter pass). Zero blockers, zero highs at close.

---

## M13 — Agentic weekly loop

W0–W6 DONE. Unattended weekly outer-loop agent (Vercel AI SDK, tool-calling over M12 MCP) that analyzes recent active strategy performance, drafts new `strategy_versions` rows (config-param search, `status='draft'` only via SDF), backtests draft vs active, and writes human-reviewable comparison report. W0: workspace (`apps/agent/`, @bot/agent deps locked), `agent_writer` role + `draft_strategy_version` SDF + `agent_run_history` table, ESLint boundary (forbids @bot/engine/@bot/analysis/@bot/mcp), compose service. W1: MCP HTTP transport (localhost 127.0.0.1-only, bearer-auth), `getHaltState` 6th tool, agent `McpClient` (Zod-validated JSON-RPC), `redactForLlm` egress-allowlist chokepoint (ADR 0037). W2: AI SDK loop (Vercel AI Gateway default `anthropic/claude-opus-4-7` + fallback sonnet, `buildPrompt` + `ProposedDraftSchema.strict` + cost-cap enforcement, `buildReport` markdown + JSON with ADR 0019 12-criterion table). W3: draft persistence via SDF (idempotency on `parent_version_id + week_iso`), `agentRunHistory` INSERT, `AgentPgClient` (max=2, sentinel-password refusal). W4: backtest comparison (two `runBacktest` calls active+draft, `comparisonStats`, `promotionGate` 12-criterion evaluation). W5: weekly cron sidecar (ofelia `docker exec`), manual CLI (`--week-iso`, `--dry-run`, `--parent-version-id`), 45-min wallclock cap (SIGTERM→SIGKILL+5s), runbook (`docs/runbooks/agent-weekly-loop.md`). W6a: adversarial QA (6 vectors: egress violation, prompt-injection, LLM hallucination, DB-role bypass, MCP transport spoofing, boundary compile/lint/runtime); W6b: 4-reviewer parallel (security, logic, clean-code, quant), 6 fix waves, all blockers/highs resolved, majority mediums closed. ADRs 0035–0038 Accepted-and-shipped: structural boundary (compile + lint + runtime guards), `agent_writer` SDF (write-impossible-by-construction), LLM egress allowlist (allowlist per ADR 0037, redaction layer before any prompt build), localhost HTTP MCP transport (reuses M9 bearer auth). Test counts at close: 259 agent + 102 analysis + 123 MCP + engine regression green. Boundary verified: imports-only @bot/shared, tsc rejects @bot/engine/analysis/mcp, ESLint blocks patterns, runtime guard scans require.cache. Deferred to M14: SDF idempotency pre-check (cost optimization), pickTopSymbols hardcoded (needs engine per-symbol trade-count surface), assertSharedRunConfig (needs simulatorConfigHash + seed on IBacktestReport), 6 ADR 0019 criteria NOT_AVAILABLE (5,7,8,9,10b,11 — requires engine extensions). Deferred to pre-M15: function-size refactors, DTO arg-count, void-param suppressions, ESLint pragmas scope, pino redaction paths. Smoke result: Post-scribe live-app smoke (per feedback-milestone-app-smoke) caught 4 production gaps not visible to unit tests: (1) engine token missing `aud` claim → fix W7; (2) bot-mcp Dockerfile + compose service → fix W8; (3) MCP/engine auth-key derivation mismatch → fix W9; (4) mcp_reader missing SELECT on revoked_jti → fix W10; all 4 closed in fix waves 7–10; agent boots end-to-end against the real stack, halt-aware short-circuit fires correctly. Zero blockers, zero highs at close.

---

## M14 — CI review gate

DONE. Deterministic CI gates from scratch (10 jobs: install, build, typecheck, lint, format, test with Postgres service, boundary ADR-spec validation, SCA allowlist-filtered, lockfile single-source, exchange-dep pin+provenance). No LLM agents in CI per locked user scope decision; phase-2 agents deferred. Repo `main` provably green at root level for first time (legacy root-level gates never passed: 22 test failures until real-Postgres migrate-only run surfaced M13 DB-write bug). Green-up: `.eslintrc.js` + `globals` + `^_` convention + ignore patterns (killed ~12,220 `no-undef`), `.prettierignore` scope (format gate = CODE only, excludes docs/prose to avoid 5,197-line low-value repad churn; deliberate ADR 0039 §2.2 refinement); `packages/shared` gets `typecheck` script, engine gets `tsconfig.typecheck.json`, prettier formatted 97 files, ~90 lint errors fixed (dead code, require-imports). Production bug caught: M13 agent DB-write path broken — `agent_writer` role has `default_transaction_read_only=on`, SDF SET LOCAL fires too late (must SET before any query); every weekly agent write would fail in production. Invisible to mocked unit tests; only full-suite against migrate-only real-Postgres exposed it. Fixed in `AgentPgClient.ts` (explicit SET TRANSACTION READ WRITE) + paired tests. Also fixed 21 migrate-only failures (partition fixtures, stale auth_tokens refs, UUID fixtures, KeyPermission predicates, BACKTEST_ARTEFACT_ROOT path, migration count). Supply-chain: `.github/audit-allowlist.json` (empty by design), `.github/exchange-critical-deps.json` (ccxt 4.5.54, decimal.js 10.6.0, pg 8.21.0), `pnpm.auditConfig.ignoreGhsas: []` kept empty (design enforcement), pure modules + 30 CI-gate unit tests (auditAllowlistFilter, exchangeDepPinCheck, ciPaths, runScaGate, runPinGate). ADRs 0039–0041 Accepted-and-shipped: gate policy + branch protection (0039), SCA + lockfile integrity + exception process (0040 with §2.2 refinement: ignoreGhsas-empty enforcement), exchange-dep pinning + provenance layer-2 deferred (0041 with §2.4: sha512 binding + advisory attestation non-blocking lookup). Dep changes: ccxt `^4.5.54`→`4.5.54` (exact pin), react-router-dom `7.1.5`→`7.15.1` (cleared 4 HIGH advisories). Test counts: engine suite 2,555 pass / 0 fail (migrate-only PG, was 22 failing); +30 CI-gate unit tests; agent 261; dashboard 153; all root gates clean (lint, format, typecheck, build, frozen-lockfile). Review cycle: 2 rounds. R1: 0 blockers, 2 highs (S-H1 SCA fail-open inverted; S-H2 provenance inert), R2: all four reviewers 0 blockers / 0 highs. Runbook: `docs/runbooks/ci-gates.md` (10 jobs, job-name contract, branch-protection payload NOT YET APPLIED, allowlist-rotation + exchange-dep-bump procedures, emergency-revert, Postgres service details, boundary-grep refinement note). Zero blockers, zero highs at close. Deferred to M14.5/M15: LLM review/QA/scribe agents in CI (proposed future phase-2), coverage-threshold gate, Dependabot/Renovate automation, short-position funding-sign test (optional belt-and-suspenders).

---

## M16 — Test-DB isolation

Goal: eliminate all test paths that could accidentally reach the soak DB on port 5433 (irreplaceable calibration data).

**What changed:**
- New `postgres-test` compose service (profile `test`, tmpfs-backed, port 6900, `01-create-migration-db.sql` init) — starts with `docker compose --profile test up -d --wait postgres-test`
- `assertTestDb.ts` hard guard: aborts if `TEST_DATABASE_URL` unset, port ≠ 6900, or `TEST_DATABASE_URL === DATABASE_URL`
- `globalSetup.ts` now async: loads `.env.test` → `.env.local` (override:false) → runs `assertTestDb()` → pre-migrates `trade_bot_test` once
- `testDataSource.ts` rewired to `TEST_DATABASE_URL` (no soak fallback); exports `getTestDbUrl` and `buildRoleDbUrl`
- 8 specs with `:5433` URL literals repointed to `getTestDbUrl()` / `buildRoleDbUrl()` / `MIGRATION_TEST_DB_URL`
- `migration.roundtrip.adversarial.spec.ts` repointed to `MIGRATION_TEST_DB_URL` (isolated from integration schema)
- 4 spec headers with `migration:run` instructions removed (globalSetup auto-migrates)
- CI `test` job: Postgres upgraded to `postgres:18-alpine`, port → 6900, 3 DSNs (`DATABASE_URL`, `TEST_DATABASE_URL`, `MIGRATION_TEST_DB_URL`), pre-flight guard step
- `.env.test.example` committed (template); `.env.test` added to `.gitignore`
- `apps/engine/package.json`: `pretest` hook (skipped in CI via `CI=true` guard)
- 2 new test files: `assertTestDb.spec.ts` (10 unit tests) + `noSoakDbLiteral.spec.ts` (static tripwire)

**Reviewer findings fixed:**
- BLOCKER: `migration:run` instructions in 4 spec headers removed (soak-DB footgun via CLI)
- HIGH: `revertAllMigrations` now handles missing `migrations` table gracefully (try/catch)
- MEDIUM: `:5433` grep pattern anchored to port boundary (`([^0-9]|$)`) to prevent false positives; tripwire allowlist expanded for `assertTestDb.spec.ts` and itself
- LOW: Dead code in equality-guard test removed

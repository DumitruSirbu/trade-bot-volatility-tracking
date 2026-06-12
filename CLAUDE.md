# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

Crypto volatility-tracking trading bot (Binance USDT-M Futures, TypeScript/NestJS).
Priority is **conservative, low-risk survival over returns**. Full design and locked
decisions in `docs/plans/00-overview.md` — read it before any non-trivial work.

Use **Claude Opus** (`/model`). The main session orchestrates.

## How to work in this repo

The **main session is the orchestrator** (subagents cannot spawn subagents). For every
non-trivial task, decompose the work, dispatch specialists with `Agent`, run reviewers,
trigger the scribe, and report a summary. **Verify the actual diff after each wave** —
agent summaries describe intent, not reality.

Specialist agents live in `.claude/agents/`. Dispatch in waves:

1. **Serial:** `bot-shared-maintainer` for shared-contract changes (before engine/dashboard).
2. **Parallel:** `bot-engine-nestjs` + `bot-dashboard-react`.
3. **Serial:** `bot-qa-engineer`.
4. **Parallel:** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`.
5. **Serial:** `bot-scribe` to close out docs + work-log.

Each agent's ownership is defined in its `.claude/agents/<name>.md` frontmatter.

## Hard rules

1. Follow the dispatch waves for every non-trivial change. Don't skip reviewers or the scribe.
2. **Read `docs/best-practices/code-conventions.md` before engine code.** Authoritative; overrides generic Clean Code where they conflict.
3. **Read `docs/best-practices/dev-qa-cycle.md` before dispatching any fix or QA wave.** Authoritative process rules — ≤5 items/files per dispatch, adversarial QA, architect on contract touches, reviewer continuity across rounds, paired tests per fix item, orchestrator verifies every diff. Distilled from the M5 retrospective.
4. **Use `context7-mcp` before calling any third-party API** (per `~/.claude/CLAUDE.md`).
5. **Shared types live in `packages/shared/`** — route changes through `bot-shared-maintainer`.
6. Quality over speed. Smaller iterations even if there are more of them. Cycle review/fix until zero blockers, zero highs, majority of mediums resolved.
7. **Branch naming (MUST):** every branch is `<type>/<branch-name>` — `feat/` (feature), `fix/` (bug fix), `hotfix/` (urgent prod fix), `chore/` (core/tooling/docs/deps). Lowercase kebab-case name. `main` is the only unprefixed branch. See `docs/runbooks/ci-gates.md` §0.
8. **NEVER destroy database data or postgres infrastructure (ABSOLUTE).** The following are permanently forbidden without explicit written confirmation from the user in the same conversation turn:
   - `docker compose down -v` or any command with the `-v` / `--volumes` flag
   - `docker volume rm` targeting any postgres volume
   - `DROP TABLE`, `TRUNCATE`, `DELETE FROM` on any production/soak table without a WHERE clause scoped to test data
   - Dropping or recreating the `postgres` compose service or its named volume
   - Any migration rollback (`revert`) in a live/paper soak environment
   - `docker system prune` or `docker image prune` — these can remove the postgres image and named volumes depending on flags
   The soak DB accumulates irreplaceable calibration data. Loss cannot be undone. When in doubt, do nothing and ask.
9. **Always take a dump before any DB or postgres container operation.** Before executing ANY of the following, stop and run a full `pg_dump` first — then show the user the dump path and ask for explicit confirmation to proceed:
   - Any `docker compose` command that restarts or recreates the `postgres` service
   - Any schema migration (up or revert)
   - Any bulk `DELETE` or `UPDATE` touching more than one row
   - Any change to `docker-compose.yml` that affects the `postgres` service or its volumes
   Dump command: `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`
   After the dump, prune old `backup_` files — keep only the **2 most recent**: `ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`
   Do not proceed with the operation until the user confirms the dump completed and they are ready.

## Trading-safety invariants (non-negotiable)

- **No order path bypasses the risk gate.** Strategies/controllers never call the exchange order API directly.
- **Strategies are pure and deterministic** (no `Date.now()`/`Math.random()`/I/O) so backtests reproduce live behavior.
- **No LLM in the live trade loop** — outer-loop only; proposes reviewed, backtested code, never executes.
- **Money is `decimal`, never float.**
- **Exchange keys never committed; key is least-privilege (no withdrawals).**
- **Validate on testnet first**; go live only at minimal size.
- **The VWAP trigger is a detector, not a direction** — fade/follow/skip decided empirically per `flow_type` and regime.
- **No daily profit target.** `skip` is the expected outcome for most triggers; success is risk-adjusted survival.
- **Live starts restricted** ($500–$1,000, 1 position, tier-1 only, isolated margin); caps relax only after confirmed live edge.

## Documentation map

- Overview + locked decisions → `docs/plans/00-overview.md`
- Milestone plans → `docs/plans/`
- **Milestone outcomes (test counts, bugs caught, reviewer rounds, ADR context)** → `docs/milestone-log.md` *(read when debugging regressions or understanding why something was built a certain way)*
- Architecture decisions → `docs/architecture/adr/`
- Code conventions (AUTHORITATIVE) → `docs/best-practices/code-conventions.md`
- Dev + QA cycle rules (AUTHORITATIVE) → `docs/best-practices/dev-qa-cycle.md`
- Testing → `docs/best-practices/testing.md`
- Tech debt + deferred items → `docs/tech-debt.md` *(HIGH = go-live blockers, MEDIUM = feature gaps, LOW = cosmetic/refactor)*
- Work log → `docs/work-log.md`

## Status

**Current status:** M32 done (dashboard closed-positions history + Telegram position alerts), deploy pending — full milestone history, test counts, and go-live gates in `docs/milestone-log.md`.

**M32 — Dashboard closed-positions history + Telegram position alerts (DONE):** Engine-only alert widening + dashboard new UI. No migration, no shared-package change, engine restart only. Core changes: `IPositionOpenedEvent` new interface (4 consumers retyped). `IPositionClosedEvent` widened with 5 new fields (entryPrice, exitPrice, leverage, strategyVersionId, openedAt). New `positionAlertText.ts` formatter module with adaptive price precision and realized PnL labeled (net). `RiskListeners` enriched Telegram bodies. **Dashboard:** `ClosedPositionsTable` (9-column cursor-paged), `PositionsPanel` (Open/Closed toggle), `PositionDetail` (CLOSED badge), `utils.ts` (formatDurationMs + time constants). Tests: 3451 engine + 235 dashboard, all green. Review: 1 round, zero blockers/highs/mediums. ADRs: ADR-0024 (new, alert schema). Post-deploy: pg_dump → restart → 10-min smoke → confirm Telegram position alerts fire correctly. Zero blockers, zero highs, zero mediums at close.

**M31 — Zombie positions & broken position-lifecycle (DONE):** Engine-only bug fix, no migration, no shared-package change, engine restart + one-time SQL repair. Core behavior: `applyReduceFillToPosition` now promotes `PENDING_OPEN → OPEN` before any close write; `RiskStateLifecycleListener` recomputes `risk_state` accounting on lifecycle events via column-scoped upsert (never touches halt fields); boot hardened against qty=0 zombies (residual formula, no re-arm of flat rows); `findLiveRisk()` view separates live-risk from lifecycle residue. Tests: 38 new (3 new spec files), 3406 total green. Review: 2 rounds — R1 found 1 blocker (halt-clobber race) + 2 highs + 2 quant blockers (column-name bugs in raw SQL); R2 clean across all four reviewers after 4 fix rounds. ADRs: 0009 §6.3, 0012 §5, 0014 §4a amended. Post-deploy: pg_dump → stop → SQL repair (3 zombie rows) → restart → 10-min smoke → first-fill watch (open tx, POSITION_OPENED_EVENT, risk_state recompute both sides). Zero blockers, zero highs, zero mediums at close.

**M29 — Paper funnel diagnosis + first-fill enablement (DONE):** Code-only, no migration, no shared-package change, engine restart only. Core behaviour change: `PositionSizer` now accepts `maxExposurePerCoinUsdt` as sizing input and clamps risk-targeted notional to `min(riskTargeted, leverageCeiling, maxExposurePerCoinUsdt)` via `clampToCeilings`. New field `effectiveRiskUsdt: MoneyValue` on `IIntentSizing` — post-ceiling-clamp realized dollar risk. Cap threaded into both sizing call sites: `StrategyService.buildOrderIntent` (live) and `BacktestOrchestrator` (replay). `RiskGateService.checkExposureCaps` unchanged (final authority / defence in depth). Funnel observability: new `getFunnelSummary(ds, fromDate, toDate)` query function in `packages/analysis/src/query/` exports `IFunnelSummaryRow` — per-UTC-day rollup of `action='open'` decisions with three-way `gate_allowed` bucket (approved/rejected/unknown), `isHalted` from `reason='global_halt'`, `sl_outside_liquidation` sub-cause split. Config hygiene: `.env` removed duplicate `MAX_OPEN_POSITIONS=1`, single authoritative `=3`; `.env.example` clarified live=1, paper=3. ADR-0004 §8a added, ADR-0042 §4 amended (M29 reversal of "no PositionSizer change" lock). Two MEDIUM tech-debt entries: differentiated correlated slot-C (gated M29 soak), `sl_outside_liquidation` forensics. Tests: 66 new (PositionSizer 24, getFunnelSummary 32, correlated 10) + 8 fixture updates. Total: 3,256 engine + 134 analysis, all green. Review: 2 rounds — R1 found 1 quant MEDIUM + 3 clean-code must-fix + 3 should-fix + 1 adversarial bug (all fixed R2); R2 clean across all four reviewers. **Post-deploy:** pg_dump, stale-halt inspection, 10-min smoke, first-fill watch (positions 0→≥1), 24–48h funnel monitoring via getFunnelSummary, 14-day soak (≥20 closed trades / ≥3 trading days before slot-C gate). Zero blockers, zero highs, zero mediums at close.

**M28 — Same-bar threshold recalibration + auto-resume wiring (DONE):** Code-only, no migration, engine restart only. Goal: stop `market_stress:same_bar` from burning whole trading days on routine correlated sessions. Decoupled gate threshold to new engine const `STRESS_SAME_BAR_HALT_COUNT=20` (strategy param stays 5 for flow routing). Wired same_bar into M23 auto-resume: `STRESS_SAME_BAR_RESUME_COUNT=12`, `SAME_BAR_RESUME_CLEAR_TICKS=2`. New `IResumeProfile` object; `MARKET_STRESS_RESUME_ELIGIBLE_LEGS` Set (replaces single string). **D6 bug fixed:** per-transition dedup now keyed on `{utcDate, leg, reHaltCount}` (was day-only). **D7 bug fixed:** `RiskListeners.onMarketStressResumed` now clears halt flag for all resume-eligible legs, not just breadth. Tests: 61 new, 3,198 total green. Review: 2 rounds — zero blockers, zero highs at close (R1: 1 HIGH test + 3 MEDIUMs fixed; R2: 1 MEDIUM naming fixed). ADR 0004 §6e, ADR 0042 amended. **Post-deploy:** pg_dump, stale-halt inspection, 10-min smoke, 24–48h monitor same_bar halts only on cascades, 14-day soak before live activation. **Two quant mediums (monitoring):** (a) confirm threshold=20 suppresses elevated Jun 4/5 sessions, (b) watch whether shared 3/day re-halt cap converts elevated-but-tradeable days to full-day locks. Zero blockers, zero highs, zero mediums at close.

**M26 — Shadow counterfactual fill wiring (DONE):** Engine-only fix (no migration, no shared-package change). Fixes the shadow counterfactual path so dormant strategy versions (v2 momentum, v3 hybrid) now produce real virtual PnL for same-tape comparison. Root cause: `ShadowStrategyOrchestratorService.simulateShadowFill` passed `ticks: []` into the fill simulator, which always returned `missed: true`, leaving `VirtualPositionLedgerService` empty. Changes: (1) added `loadTicksForBar(symbol, barOpenMs)` to `TickAggregateRepository` (half-open `[barOpen, barOpen+5m)`, mirrors M7 `CandleLoader`); (2) shadow now loads `tick_aggregates` **once per event** in `runShadows` and threads immutable `ISignalBarEvidence` into each shadow version; (3) entry aligns to **next-bar open** (last signal-bar tick close as proxy), mirroring M7 `BacktestOrchestrator` (ADR 0015 §6 forward-look fix); (4) declines shadow open when no tick data exists (conservative miss + debug log) — mirrors backtest returning null when no next bar; (5) `barHigh`/`barLow` derived from loaded tick set min/max (not entry price clone); (6) `lowFidelity: true` and `bookSnapshot: null` preserved (depth-aware extension still deferred). ADR 0029 amended with M26 section. 37 tests, all green. Review: 1 round — zero blockers, zero highs at close (2 MUST-FIX formatting issues + 1 HIGH dead-test fixed in the round; zero mediums outstanding). Security, logic, clean-code, quant all CLEAN. **Gate prerequisite:** M24 fill-path confirmation (paper transactions visible). **Post-deploy:** pg_dump before engine restart (prune to 2-deep retention); engine restart only (no migration); 10-min live smoke (confirm no module cycle — shadow boots with `TickAggregateRepository` injected); 24–48h confirm `shadow_decisions` OPEN rows now show a mix of `missed=false`/`missed=true` (NOT 100% missed) and `VirtualPositionLedgerService` records virtual positions; spot-check shadow `event_id` uses same `tick_aggregates` rows as backtest would for that bar; watch tick-coverage (A9) — if many bars return `[]`, investigate persistence lag / write-read race.

**M25 — Paper exploration enablement (DONE):** Code-only fix (no migration, no DB write at rest). Unlocked the paper soak volume by: (P1) activating v2 momentum (config-only, `ACTIVE_STRATEGY_VERSION_ID=3`), (P2) relaxing non-breadth stress legs via single shared helper (never-relaxed: invalid-inputs, breadth; relaxed: BTC/ETH shock, OI, funding, spread), (P3) raising exposure headroom while keeping 3-slot ceiling in all envs (true 5-slot expansion deferred). Every relaxation `EXCHANGE_ENV=paper`-gated and default-off in code; non-paper boots are byte-identical to pre-M25. ADR 0042 locked per-leg relax table, 3-slot model rationale, sizing profile with same-direction cap, paper-gating semantics. 45 new tests, 3,073 total green. Review: 2 rounds — zero blockers, zero highs at close. **M24 prerequisite:** confirm fill-path green (IOC fills, event-time tsMs). **Post-deploy:** pg_dump+2-deep retention before restart (no migration); apply paper `.env`; evidence-gated `clearHaltForDate` for current day; 10-min smoke (v2 active, no re-halt); 24–48h positions confirmation (up to 3 concurrent); 48h funnel-mix (halt share down, split residuals).

**M24 — Live/paper open-fill wiring (DONE):** Code-only fix (no migration, no DB write). Paper opens now fill: synthesized one side-aware executable-price tick per MARKETABLE_LIMIT_IOC open in StreamingFillAdapter (A1), overrode tsMs to event-time (A2), replaced stale comment. Extracted isPositiveDecimalString utility. 20 new tests green, 212 total. Review: 2 rounds — zero blockers, zero highs at close. **Post-deploy:** pg_dump before restart; fill-path confirmation (no live trades expected from M24 alone — M25 P1/P2 needed; first visible paper transactions appear after M25 lands). Three live outcomes: no gate approvals → no positions (M24 not exercised); approvals with missed fills → M24 failed; approvals with filled opens → M24 verified.

**M23 — Market-stress adaptive auto-resume (DONE):** Code-only fix (no migration, no DB write at rest). Breadth-triggered `market_stress` halts now auto-resume after `MARKET_STRESS_RESUME_CLEAR_TICKS=3` consecutive clean global-breadth ticks in the inner hysteresis band ([20,80] at distance ≤30). Engage threshold unchanged (|breadth−50| ≥ 40). Per-day re-halt cap: 3rd breadth halt → full-day lock reasserts. `halt_reason` now carries `market_stress:<leg>` suffix (`:breadth` is the only resume-eligible leg; all others and loss halts stay full-day locked). New `MARKET_STRESS_AUTO_RESUME_ENABLED` boot flag: paper-default-on, live-default-off. 116 new tests green. Review: 2 rounds — zero blockers, zero highs at close. **Post-deploy:** pg_dump before restart; stale-halt inspection (`halt_reason LIKE 'market_stress%'`); 10-min smoke; backtest over soak window (report stats for trades within 30 min of auto-resume); 14-day paper soak before live activation.

**M22 — Depth-floor recalibration (DONE):** Code-only fix (no migration, no DB write). Recalibrated `COIN_DEPTH_FLOOR_10BPS_USDT` from M19 round numbers to book-consumption-ratio anchors: `{ TIER_1: 10_000, TIER_2: 2_500, TIER_3: 2_000 }` (one-sided, $250 max order). Soak evidence: 10 rejects on 2026-06-04; 7 unblocked at $3,468–$9,174; 3 still blocked at $529/$681/$2,321. ADR 0004 §6a superseded in place; §6b breadth-distance corrected 30→40 (drift fix). 23 new tests green. Two MEDIUM tech-debt entries added (volume-only tier ranking; entry-vs-exit depth gap). Review: 2 rounds — zero blockers, zero highs at close. **Post-deploy:** pg_dump before restart; no clearHaltForDate needed (depth guard is a per-decision skip, not a halt); 10-min smoke; funnel-mix check 24–48h; 14-day realized-vs-modeled slippage telemetry mandatory before scale-up (ADR §6a calibration condition).

**M21 — Index-shock horizon alignment (DONE):** Code-only fix (no migration, no DB write). Switched BTC and ETH index-shock legs to 5-minute horizon. BTC: `stress_btc_1m_shock_pct` (1m strategy param, 1.0%) → `STRESS_BTC_5M_SHOCK_PCT = 1.5` (engine const). The 1m BTC leg was empirically inert (peak 0.56% in soak vs 1.0% floor). ETH: `STRESS_ETH_5M_SHOCK_PCT` raised 2.0 → 2.5 (only near-event was 2.12%; 2.5% is slightly conservative per 1.2–1.5× ETH beta relative to BTC). Atomically updated `hasInvalidStressInputs` guard from `btc_1m` to `btc_5m` (fail-closed). Deprecated 1m params retained for replay compatibility. ADR 0004 §6c added. 191 tests green. Review: security/logic/clean-code CLEAN; quant HIGH (backtest BTC candle-return vs live rolling-window move divergence) logged as MEDIUM tech-debt (acceptable fail-direction: fewer false halts, not missed ones; expected to resolve from post-deploy soak telemetry per ADR 0004 §6c). Zero blockers, zero highs, zero mediums at close. **Post-deploy:** stale-halt inspection (if `is_halted=true` under old thresholds and tape calm, clear via `clearHaltForDate`), 10-min smoke, 14-day near-miss telemetry watch.

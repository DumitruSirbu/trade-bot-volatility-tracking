# Tech Debt

Deferred items. **HIGH** = go-live blocker or live risk. **MEDIUM** = feature/correctness gap. **LOW** = cosmetic/refactor. Remove when resolved.

## HIGH

| # | Item | Location | Origin |
|---|------|----------|--------|
| H3 | LIVE `/sapi/v1/account/apiRestrictions` master-account shape verification — sub/master shapes diverge; predicate could silently pass unsafe key | `KeyPermissionAssertionService` | M11a |
| ~~H4~~ | ~~Rate-limit drift `header-used ≈ 1` anomaly~~ **RESOLVED (M46)** — separate-ledger confirmed (host boundary: `/fapi` vs `/sapi`). New `SAPI_REQUEST_WEIGHT_1M` bucket (local-only) isolates `/sapi` boot calls. ADR 0030 §2.7 amended. | `apps/engine/src/exchange/` | M46 |
| H5 | **RECONCILED_MISSING closes with null exit_price / null realized_pnl in LIVE mode** — when a close order gets a non-clean result (unknown intent outcome), position transitions to RECONCILING; if exchange then shows the position gone, ReconciliationService finalizes it via `RECONCILED_MISSING` without fetching the actual closing fill from exchange history (`fetchOrdersByClientId` / `fetchMyTrades`). In LIVE, exit_price, realized_pnl, fees are permanently null. Must fetch real fill data before finalizing. | `ReconciliationService.ts:handleDbOpenNotOnExchange`, `StuckPositionSweeper.ts:sweepReconcilingParked` | M40+soak |
| H6 | Engine auth CLI token TTL 900s — weekly agent runs need automated minting or long-lived issuance | `apps/agent/` | M13 |
| H7 | Branch protection payload NOT YET APPLIED — apply via `docs/runbooks/ci-gates.md` before any live merge | GitHub settings | M14 |

## MEDIUM

| # | Item | Location | Origin |
|---|------|----------|--------|
| M1 | `sl_outside_liquidation` forensics required before any VWAP-stop change — 66 rejects in M29 soak; run `getFunnelSummary` sl sub-cause split first | `RiskGateService`, `packages/analysis` | M29 |
| M2 | Live/backtest idiosyncrasy scoring diverge — `BacktestEventBuilder` uses private formula vs `computeIdiosyncrasyScore`; same input → different gate outcome | `BacktestEventBuilder.ts`, `computeIdiosyncrasyScore.ts` | M30 |
| M6 | `decisions.position_id` never written — forces LATERAL time-join in analysis; column + FK exist on entity | `StrategyService.ts`, `DecisionEntity` | M31 |
| M7 | MAE/MFE seed-timing gap — accumulator seeded async post-`POSITION_OPENED_EVENT`; first-second excursion (peak risk window for this strategy) may be lost. **Blocks empirical `min_rr` re-tune (M47 Task 5):** `mfe_pct`/`mae_pct` near-zero/unpopulated, so M47 ships `min_rr` provisional (1.5 core / 1.0 gate); backfill + re-tune deferred here. | `PositionInstrumentor.ts` | M35, M47 |
| M8 | B6 window discipline — `compareVersions`/`getPerformance` need `from ≥ M40-deploy` guard to exclude pre-M40 degenerate hollow rows | `compareVersions.ts`, `getPerformance.ts` | M40 |
| M9 | M15 soak evaluator wave (CRN tape, TOST calibration, sample-size pre-flight, lowFidelity rankings) — gate before go-live | `docs/plans/archive/M11a-local-soak.md` | M11a |
| M10 | BTC index-shock candle vs rolling-window — `resolveBtcMovePct` uses candle close-to-open; live uses rolling 5m tape; replay shows fewer BTC halts than live | `BacktestRunnerService.ts:902` | M21 |
| M11 | Breadth-stress calibration — validate `MARKET_STRESS_RESUME_CLEAR_TICKS = 3`, resume hysteresis (distance=30), signal-dependent N for BTC/ETH/OI/funding post-soak | `riskConsts.ts` | M19→M23 |
| M12 | Volume-only tier ranking — tiering ignores book depth; `$10k` floor patches symptom, not ranking logic | `ExchangeModule` (`CoinTierEnum`) | M22 |
| M13 | Entry-vs-exit depth gap — coin can pass entry depth guard then gap on SL exit; `MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2` is reactive not preventive | `RiskGateService`, `PositionSizer` | M22 |
| M14 | Post-resume directional cooldown — suppress fade entries on surged cohort for M bars; **escalate to HIGH** if soak shows entries within minutes of surge-resume | `RiskGateService`, `StrategyModule` | M23 |
| M15 | Time-stop deadline index hardening — symbol-sharded eviction, index/DB consistency self-heal, hot-path profiling >3 open positions | `PositionTimeStopEnforcer.ts` | M33 |
| M16 | Reconciliation-tick fallback — `PositionTimeStopEnforcer` fires only on `price.update`; halted/delisted/feedless symbols never swept | `PositionTimeStopEnforcer.ts`, `reconciliation/` | M33 |
| M17 | PENDING_OPEN indexing gap — deadline index armed only post-`POSITION_OPENED_EVENT`; row stalled in PENDING_OPEN is unprotected until restart | `PositionTimeStopEnforcer.ts` | M33 |
| M18 | Shadow consecutive-loss gate not driven by simulated PnL — force_close/SL/TP exits not fed through `tryClose` | `VirtualPositionLedgerService.ts` | M37 |
| M19 | `pairedTradedEventCount` inflation — force_close ~0-PnL rows inflate pair count; full-window rescore needed for higher-precision analysis | `compareVersions.ts` | M37 |
| M20 | ADR 0004/0009/0010 amendments pending (slot release lifecycle, closed-path release, no-double-release idempotency) | `docs/architecture/adr/` | M34 |
| M21 | Shadow orchestrator size — `runOneShadow` 179L, `rebuildLedger` 59L; extract private helpers, no functional change | `ShadowStrategyOrchestratorService.ts` | M37 |
| M22 | Idiosyncrasy-threshold calibration — `min_score = 0.5` is evidence-pending; `getIdiosyncrasyMissDistribution` accumulates histogram before any move | `SeedStrategyVersions.ts`, `packages/analysis` | M30 |
| M23 | **[gated: `slotCGateOpen = true`]** Correlated slot-C strategy — current path uses idiosyncratic logic; needs BTC regime classifier, trend-following entry/exit, independent backtest | `SlotManager`, `StrategyService`, `PositionSizer` | M29 |
| M24 | `max_tp_dist_factor = 5.0` provisional default — backtest verdict in `docs/analysis/20260629-max-tp-dist-factor-shadow.md` (EXP-004): raising to 7.0 adds 72 trades at identical 23.4% WR, net PnL −$535→−$671 (worse). Tier2 extra trades bleed −$115; time-stop dominance persists 79→82% (same issue as EXP-001). Do not raise the cap. Signal quality (flow_type, idiosyncrasy gating, entry timing) is the real lever (EXP-003). Shadow v19 continues for monitoring but should not promote to live. | `momentumCore.ts:139-145`, `strategy_versions.params` | M47, M48, EXP-004 |

## LOW

| # | Item | Location | Origin |
|---|------|----------|--------|
| L1 | `FillAcceptanceUnwindService.buildDeRiskContext` unsafe as-casts for `IRiskGateContext` — safe today (FLATTEN skips guards, ADR 0045 §D2) but latent if de-risking expands | `FillAcceptanceUnwindService.ts` | M38 |
| L2 | D4 sweeper RECONCILING staleness uses `openedAt` (no `transitioned_at` column) — conservative; add column if sweeper goes LIVE | `StuckPositionSweeper.ts`, `PositionEntity` | M40 |
| L3 | Verify `risk_state.trades_count` not incremented on swept never-filled PENDING_OPEN rows | `RiskStateLifecycleListener.ts` | M40 |
| L4 | ETH index-shock leg dead in backtest — `eth5mMovePct` hard-seeded 0; ETH threshold uncalibratable from replay | `BacktestRunnerService.ts:593` | M21 |
| L5 | `ISimulatedFillCore.missedReason: string` vs `ISimulatedFill.missedReason: MissedReasonEnum` — intentional asymmetry; consolidate if adapter diversity proves unnecessary | `packages/shared/src/interface/` | M27 |
| L6 | Persist `stress_rehalt_count` — in-memory; mid-day restart resets per-day re-halt cap (more-permissive quirk, reviewed/accepted) | `RiskGateService` | M23 |
| L7 | Remove dead `EXCHANGE_TESTNET` env var — superseded by `EXCHANGE_ENV`; cost debugging time M17 | `EnvironmentVariables.ts:69` | M17 |
| L8 | Alert type semantic pollution — `UNHANDLED_EXCEPTION` reused for backup failures, drift, rate-limit events; add `BACKUP_FAILURE`, `DRIFT_DETECTED`, `RATE_LIMIT_DRIFT` | `backup/`, `alert/`, `exchange/`, `packages/shared/` | M17, M18 |
| L9 | Real-429 hardening — batch/space 100-symbol OI & funding bursts (~10% headroom) | `apps/engine/src/exchange/` | M18 |
| L10 | Shared-type backlog: `HaltSourceEnum.PAPER_DRAWDOWN`/`PAPER_RECONCILIATION_DRIFT`, `IExchangeOrderSnapshot → IOrder` full migration, simulator-config-hash real source | `packages/shared/`, `apps/engine/` | M11a |
| L11 | Strategy-comparison UI (walk-forward OOS, bootstrap CIs, per-regime tables, charting) — blocked on depth-aware + lowFidelity extension | `apps/dashboard/` | M11 |
| L12 | CI backlog: code coverage threshold gate, Dependabot/Renovate supply-chain automation, multi-value `IN (...)` filter server-side | `.github/`, `DecisionRepository.findPage` | M14, M11a |
| L13 | DB/schema backlog (M13): missing `decisions(position_id, ts)` index, GRANT CONNECT identifier quoting, `mcp_reader` NOLOGIN-until-rotate | DB migrations | M13 |
| L14 | Agent/analysis backlog (M13): `pickTopSymbols` hardcoded to 3 symbols, `assertSharedRunConfig` window-only, 6 ADR 0019 promotion-gate criteria NOT_AVAILABLE, SDF idempotency pre-check | `apps/agent/`, `packages/analysis/` | M13 |
| L15 | HaltService CC backlog (M11a): `emitHaltChanged`/`writeAudit` DTO extractions, `engageHalt`/`resume` size (58L/44L), `utcDateString` dedup, `notePragmaticTransition` consolidation, `currentStateLabel` extract, `wasAlreadyHalted` rename, dead `FakeControlAuditRepository` methods | `HaltService.ts`, related specs | M11a |
| L16 | Dashboard CC backlog (M11a): `COLUMN_HELP` inline JSX, `applyClientFilter`/`toServerFilter` dedup, `RiskHaltStatePortAdapter` barrel comment | `DecisionsFeed.tsx`, `risk/service/index.ts` | M11a |
| L17 | Auth/gateway CC backlog (M11): `BAD_SIGNATURE` split (W1.5), `LiveGateway` parity test (W2.5), `HKDF` sub-key derivation (W1.7), `Cache-Control` on halt/history endpoints (W2.7) | `apps/engine/src/auth/`, `HaltController.ts` | M11 |
| L18 | MCP/agent CC backlog (M13): `waitForChild`/`buildRuntime`/`listPositions` size, `verifyBearer`/`runUnderWallclock` extractions, arg-count DTOs, `McpToolErrorKindEnum` as TS enum, ESLint pragma noise, pino redact paths broadening | `apps/mcp/`, `apps/agent/`, `apps/engine/` | M13 |
| L19 | `ISizingInput` co-located in `PositionSizer.ts` instead of `interface/` — conventions require interfaces in `interface/` sub-folder | `apps/engine/src/risk/service/PositionSizer.ts` | M45 |
| L20 | Module-level `const MAX_LEVERAGE_DEC` / `FUNDING_CUT` at top of service files instead of `const/` — conventions require configurable constants in `const/` folder | `apps/engine/src/risk/service/PositionSizer.ts`, `RiskGateService.ts` | M45 |
| L21 | Raw `throw new Error()` in `RiskStateRepository.clearHaltForDate:39` — domain exceptions required, not raw `Error` | `apps/engine/src/risk/repository/RiskStateRepository.ts` | M45 |
| L22 | MCP test files missing `.js` extensions on relative imports (nodenext requirement) — causes LSP errors; tests run via ts-jest. `tsconfig.test.json` added as workaround for `tsc` checks. | `apps/mcp/tests/` | M44/M45 |
| L23 | `apps/mcp/src/transport/bearerVerifier.ts` — no max-token-lifetime ceiling check; token with far-future `exp` passes indefinitely until revoked | `apps/mcp/src/transport/bearerVerifier.ts` | M45 |
| L24 | `computeStructuralStop` has 6 parameters — group `{ entryPrice, deviationWickPrice, structuralStopWickBufferPct, structuralStopHardCapPct, rrSlCapDistance }` into `IStructuralStopParams` (pre-existing 5-arg issue extended by M47 Task 3) | `apps/engine/src/strategy/service/computeStops.ts` | M47 |
| L25 | `momentumCore` private functions take 3-4 params — introduce `IMomentumGeometryContext` DTO grouping `{ tradeSide, referencePrice, event, params }` (mirrors the `IMeanReversionGeometryContext` pattern used in M47 Task 3) | `apps/engine/src/strategy/strategies/momentumCore.ts` | M47 |
| L26 | `PCT_DIVISOR = new Money(100)` is duplicated in `meanReversionCore.ts` and `computeStops.ts` — consolidate into `apps/engine/src/strategy/const/strategyConsts.ts` | `apps/engine/src/strategy/strategies/`, `apps/engine/src/strategy/service/` | M47 |
| L27 | `resolveSlFloorDistance` in `meanReversionCore.ts` has 3 parameters — fold `atr14` into a sub-property of `IMeanReversionGeometryContext` once that DTO is established (pairs with L25 refactor) | `apps/engine/src/strategy/strategies/meanReversionCore.ts` | M47 |

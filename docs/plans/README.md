# Milestone index

Status vocabulary: `ACTIVE` | `PLANNED` | `DONE` | `DEFERRED` | `INDEX`.

Exactly **one** row may be `ACTIVE`. Status lives here only — not in plan frontmatter.

| ID | Status | Summary (1 line) | ADRs | Modules |
|----|--------|------------------|------|---------|
| M50 | PLANNED | Cross-sectional momentum (xmom) — PAPER + shadow only. **M50b increment DONE (2026-07-01, ADR 0050):** rank-cascade in orchestrator, `top_n` default 3, fixed 01:07 UTC cron; `IPortfolioSelection.ranked` full list. See [M50b outcome](../milestone-log/archive/M50b.md). Core M50 soak/promotion gates still open. Original brief: rank universe by trailing 24h return, 24h cadence (EXP-011/012). `IPortfolioStrategy` + `crossSectionalMomentumCore`; `RebalanceSchedulerService` + `MomentumOrchestratorService` through unchanged risk gate. Disjoint slot namespace (D4) still deferred. | 0047, 0048, 0050, 0004, 0003 | strategy, risk, shared, market-data, paper-mode |
| M49 | DONE | Fetch the real closing fill before finalizing `RECONCILED_MISSING` (tech-debt H5) — LIVE rows finalized as reconciled-missing currently write null `exit_price`/`realized_pnl`/`fees` permanently because `finalizeRealizedPnl` aggregates an empty local ledger. Add a read-only `fetchMyTrades` account-history facade (`IMyTradeSnapshot`, decimal-as-string, D14-guarded) + `IAccountStateSource` port method; record the fetched reduce/close trades into the `transactions` ledger (`recordReconciledClosingFills`, idempotent on trade id) **before** the unchanged finalize runs, in both `ReconciliationService.handleDbOpenNotOnExchange` (case-b) and `transitionOutOfReconciling` closed-branch (case-f). Empty/failed fetch falls through to null PnL so the close never stuck. `StuckPositionSweeper` excluded (PAPER-only / fill-less). LIVE-only; PAPER + shadow inert. Amends ADR 0010 §1b/§1f; additive note ADR 0001; ADR 0012 §5 unchanged. | 0010, 0001 | exchange, position, shared |
| M48 | DONE | Fill-anchor geometry fix — momentum geometry collapses when the live fill diverges from the reconstructed reference (live pos 212: 1.53% drift → slDist 34.5× smaller → 85:1 R:R at fill; every M47 check anchors to `reconstructReferencePrice`, never the fill). Task 0: ONE new fill-time leg in the existing `evaluateFillDrift` helper (`exitGeometryHelper.ts:39`) — side-ordering assertion + `slFloor` noise-floor + `tpDist/slDist ≥ min_rr`, all anchored to the actual fill; rejects via `FILL_ACCEPTANCE_REJECTED`/`degenerate_geometry_at_fill` through the existing synthetic-FLATTEN unwind; + ATR-unit `GEOMETRY_ANCHOR_DRIFT` log. Task 1: adversarial regression suite. No strategy-core / `entryHelpers.ts` / `RiskGateService` / shadow change; reuses M47 params; SL/TP levels unchanged (Option B preserved); live-only (backtest+shadow inert). Branch: `feat/m48-geometry-fill-anchor-fix`. | 0045 | execution |
| M47 | DONE | R:R geometry fix + MFE/MAE tracking + signal-quality data foundation — root cause of consistent negative PnL (−259 USDT, 29.8% win, 85% of trades R:R<1). Bug 1: uncoupled SL/TP anchors (all cores). Bug 2: momentum single-leg fill rebase. Couple TP↔SL in cores (momentum TP hybrid floor, mean-reversion SL cap), fix asymmetric rebase, add `RR_TOO_LOW` gate backstop + `min_rr` versioned param (provisional 1.5, empirical confirm post-deploy). MFE/MAE: live forward-tracking seed-race fix (Task 5a — resolves M7) + best-effort historical backfill (Task 5b post-deploy). Read-only `position_segment_stats` view as the M48 data foundation (Task 5c). Signal-quality *fixes* deferred to M48. Branch: `feat/m47-rr-geometry-fix`. | 0003, 0045, 0004 | strategy, risk, shared |
| M46 | DONE | Rate-limit ledger audit — Scenario A1 confirmed (separate-ledger: host boundary `/fapi` vs `/sapi`). New `SAPI_REQUEST_WEIGHT_1M` bucket (local-only); `REQUEST_WEIGHT_1M` now `/fapi`-only. ADR 0030 §2.7 amended. H4 resolved. | 0030 | exchange |
| M45 | DONE | Position-risk sizing integrity + risk-accounting hardening (D1 sizer/stop alignment H1, D2 newer-wins upsert H2, D3 persistHalt+ADD accounting M4/M5, D4 double-close race M3, D5 BAD_AUDIENCE enum H5, D6 branch-protection ops H7) | — | risk, execution, auth |
| M44 | ACTIVE | Verify shadow-fill fidelity & close the B5 gap — **soak verification gate, no fix required** (degeneracy was a pre-fix artifact, already resolved; B5 closes by ≥30-fill soak accumulation + re-measurement on pinned `from ≥ 2026-06-21` window). Optional non-blocking hardening (D1.1 schema invariant, D1.3 miss observability); contingency-only fix if degeneracy recurs at n≥30. Unblocks D1b v3-promotion *evaluation* + trustworthy `compareVersions`. ≈10 fills accumulated; need ≈9–10 more soak days. | 0029 | shadow, analysis |
| M43 | DONE | Strategy selectivity (D1a `catalyst_risk → skip` in v2, D2 3.5× long TP + cost-floor anchor, D5 phantom purge; D1b/D3 deferred) | 0003, 0045 | strategy, backtest, analysis |
| M15 | DEFERRED | Cloud go-live & scaling (D1 blocker resolved; gated behind shadow-fidelity B5 closure + v3-edge evaluation) | — | go-live |
| M40 | DONE | Halt exempt closes + shadow fill regression + stuck-position sweeper (D1 go-live unblock, D2 stop-side re-anchor, D4 orphaned-row sweep) | 0046, 0004, 0021, 0029 | execution, strategy, position |
| M41 | DONE | Decisions feed outcome clarity (D1) + zero-fill audit `cashflow` fix (D2) | 0022, 0006 | dashboard, shared, execution, analysis |
| M42 | DONE | Paper stale-tick REST refresh before fill simulation (on-demand `fetchTickers` at fill time) | 0032 | paper-mode, market-data |
| M39 | DONE | Shadow-ledger close path + realized-PnL fidelity (W1+W2 shipped, D3 gate unblocked) | 0029, 0019 | strategy, analysis |
| M38 | DONE | Exit-geometry repair + fill-acceptance guard (rebase momentum TP to fill price, reject + unwind wrong-side/over-slippage fills) | 0045, 0017, 0018, 0029 | strategy, execution, backtest |
| M37 | DONE | Strategy-comparison infrastructure (concurrent shadow evaluation + backtest fill restoration + trade-record integrity) | 0017, 0018, 0029, 0015, 0004 | strategy, backtest, analysis, position |
| M36 | DONE | Paper soak consecutive-loss-halt relaxation (disable 2-loss day-halt; keep full-day position flow + labeled-outcome collection) | 0042, 0004, 0029 | risk, strategy, config |
| M35 | DONE | Trade-record integrity (entry-snapshot persistence + wrong-side/sub-cost TP geometry; MAE/MFE seed-timing) | 0013, 0011, 0004, 0003, 0043 | position, execution, strategy, risk |
| M34 | DONE | Slot-reservation leak on the normal close path (false `max_positions_reached`) | 0004, 0009, 0010 | risk, execution, position |
| M33 | DONE | Live exit enforcement (time-stop + paper protective simulation + entry cashflow) | 0008, 0011, 0012, 0015 | execution, position, risk |
| M32 | DONE | Dashboard closed-positions history + Telegram position notifications | 0044, 0024, 0022 | dashboard, alert |
| M31 | DONE | Zombie positions & broken position-lifecycle | 0009, 0012, 0014 | position, risk |
| M30 | DONE | Idiosyncratic-edge soak gate + idiosyncrasy observability | — | analysis, risk |
| M29 | DONE | Paper funnel diagnosis + first-fill enablement | 0004, 0042 | risk, strategy |
| M28 | DONE | Same-bar stress threshold recalibration + auto-resume wiring | 0004 | risk |
| M27 | DONE | Decision data-capture completeness | 0043 | strategy, risk |
| M26 | DONE | Shadow counterfactual fill wiring | 0029 | shadow, backtest |
| M25 | DONE | Paper exploration enablement | 0042 | risk, strategy |
| M24 | DONE | Live/paper open-fill wiring | 0005, 0007 | execution |
| M23 | DONE | Market-stress adaptive auto-resume | 0004 | risk |
| M22 | DONE | Depth-floor recalibration | 0004 | risk |
| M21 | DONE | Index-shock horizon alignment (BTC/ETH 5m leg) | 0004 | risk |
| M19 | DONE | Per-coin liquidity gate | 0004 | risk |
| M18 | DONE | Directional rate-limit drift alert | 0030 | alert, exchange |
| M17 | DONE | Automated daily DB backup | — | backup |
| M16 | DONE | Test-DB isolation | — | devops |
| M14 | DONE | CI review gate (deterministic CI gates) | 0039, 0040, 0041 | ci |
| M13 | DONE | Agentic weekly loop (phase 2) | 0033–0038 | agent |
| M12 | DONE | Analysis MCP (phase 2) | 0033, 0034 | mcp, analysis |
| M11a | DONE | Local soak hardening | 0028, 0029, 0030, 0032 | soak, paper |
| M10 | DONE | Dashboard (React, containerized) | 0026, 0027 | dashboard |
| M9 | DONE | Observability, control & read API | 0020–0025 | auth, alert, api |
| M8 | DONE | Strategy versioning & comparison | 0016–0019 | strategy, backtest |
| M7 | DONE | Backtesting engine | 0015 | backtest |
| M6 | DONE | Position management & reconciliation | 0009–0014 | position, execution |
| M5.5 | DONE | Adversarial backfill (pre-M6 hardening) | — | backtest |
| M5 | DONE | Execution (testnet) | 0005–0008 | execution |
| M4 | DONE | Risk management | 0004 | risk |
| M3 | DONE | Strategy engine | 0003 | strategy |
| M2 | DONE | Persistence & data model | 0002 | persistence |
| M1 | DONE | Exchange integration & market data | 0001 | exchange |
| M0 | DONE | Foundation & scaffolding | — | foundation |
| M11 | DEFERRED | Go-live hardening (split parent) | — | go-live |
| M20 | DEFERRED | Pre-cloud go-live blocker hardening | — | go-live |
| 00-overview | INDEX | Timeless design + locked decisions | — | — |
| M9-execution-plan | DONE | M9 dispatch checklist | 0020–0025 | — |
| M10-execution-plan | DONE | M10 dispatch checklist | 0026, 0027 | — |
| M12-execution-plan | DONE | M12 dispatch checklist | 0033, 0034 | — |
| M13-execution-plan | DONE | M13 dispatch checklist | 0033–0038 | — |
| M14-execution-plan | DONE | M14 dispatch checklist | 0039–0041 | — |
| M38-impl-brief | DONE | M38 dispatch brief (D1 + D2) — engine agent | 0045 | — |

Done milestone specs live in [`archive/`](archive/). Active and deferred specs stay in this directory.

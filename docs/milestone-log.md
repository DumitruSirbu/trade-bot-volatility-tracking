# Milestone log

Per-milestone forensics. Read the specific `M<N>.md` only when debugging a regression or asking "why was this built?"

For the current milestone plan, see [`docs/plans/`](plans/README.md). For deferred items, see [tech-debt.md](tech-debt.md).

| ID | Outcome |
|----|---------|
| M47 | [M47 — R:R Geometry Fix (uncoupled SL/TP anchors + asymmetric fill-rebase) (DONE):](archive/M47.md) Root cause of −259 USDT / 29.8% win rate: Bug 1 (uncoupled SL/TP anchors in all cores), Bug 2 (asymmetric momentum fill-rebase). Delivered: Task 0 (tpRebaseEligible=false, momentum no-rebase), Task 1 (4 new versioned params: min_rr, entry_pct_floor, atr_floor_multiplier, max_tp_dist_factor; RR_TOO_LOW enum), Task 2 (momentum TP coupling to SL via rrFloor + cap), Task 3 (mean-reversion SL cap to TP), Task 4 (risk-gate R:R backstop anchored to signal reference price), Task 5a (MFE/MAE seed-timing race fix — synchronous seed in ExecutionService before first await), Task 5c (position_segment_stats view for M48 data foundation). BLOCKERs resolved: BLOCKER 1 (gate anchor parity — referencePrice field), BLOCKER 5 (rrFloor cap + degenerate skip). Deferred: Task 5b (historical backfill harness — post-deploy). Tests: 64 new tests across 6 spec files (3,983 total, 0 failures). Reviewers: 1 wave (security/logic/clean-code/quant all clean; zero blockers, zero highs, 1 MEDIUM fixed post-review). ADRs amended: 0003 (SL/TP coupling), 0045 (no-rebase Option B), 0004 (R:R backstop). Deploy: non-rolling; new shadow-status version rows v11/v21/v31 backfilled with params via JSON-merge migration; operator activates via ACTIVE_STRATEGY_VERSION_ID. Note: `min_rr=1.5` ships provisional; empirical confirmation deferred to post-deploy review on forward trades (5a seed-timing fix enables trustworthy excursion data; 5b establishes baseline only). Tech-debt M7 (MFE/MAE async seed) marked RESOLVED by Task 5a. |
| M46 | [M46 — Rate-limit ledger audit (Scenario A1: separate-ledger confirmed, host boundary split `/fapi` vs `/sapi`) (DONE):](archive/M46.md) |
| M43 | [M43 — Strategy selectivity (`catalyst_risk → skip`) + long-book RR geometry + phantom purge (DONE):](archive/M43.md) |
| M40 | [M40 — Halt-exempt closes + shadow fill regression + stuck-position sweeper (DONE):](archive/M40.md) |
| M41 | [M41 — Decisions feed outcome + zero-fill audit cashflow (DONE):](archive/M41.md) |
| M42 | [M42 — Paper stale-tick REST refresh before fill simulation (DONE):](archive/M42.md) |
| M39 | [M39 — Shadow-ledger close path + realized-PnL fidelity (W1+W2 shipped, D3 gate unblocked) (DONE):](archive/M39.md) |
| M38 | [M38 — Exit-geometry repair + fill-acceptance guard (D1+D2 deployed; D3 gated) (DONE):](archive/M38.md) |
| M37 | [M37 — Strategy-comparison infrastructure (concurrent shadow evaluation + backtest fill restoration + trade-record integrity) (DONE):](archive/M37.md) |
| M36 | [M36 — Paper soak consecutive-loss-halt relaxation (DONE):](archive/M36.md) |
| M35 | [M35 — Trade-record integrity (entry-snapshot persistence + wrong-side/sub-cost TP guards) (DONE):](archive/M35.md) |
| M0 | [M0 — Foundation & scaffolding](archive/M0.md) |
| M1 | [M1 — Exchange & market data](archive/M1.md) |
| M2 | [M2 — Persistence & data model](archive/M2.md) |
| M3 | [M3 — Strategy engine](archive/M3.md) |
| M4 | [M4 — Risk management](archive/M4.md) |
| M5 | [M5 — Execution (testnet)](archive/M5.md) |
| M5.5 | [M5.5 — Adversarial backfill (pre-M6 hardening)](archive/M5.5.md) |
| M6 | [M6 — Position management & reconciliation](archive/M6.md) |
| M7 | [M7 — Backtesting & performance](archive/M7.md) |
| M8 | [M8 — Strategy versioning & comparison](archive/M8.md) |
| M9 | [M9 — Observability, control & read API](archive/M9.md) |
| M10 | [M10 — Dashboard](archive/M10.md) |
| M11a | [M11a — Local soak hardening (PAPER mode) + Shadow-decision infrastructure](archive/M11a.md) |
| M12 | [M12 — Analysis MCP](archive/M12.md) |
| M13 | [M13 — Agentic weekly loop](archive/M13.md) |
| M14 | [M14 — CI review gate](archive/M14.md) |
| M16 | [M16 — Test-DB isolation](archive/M16.md) |
| M17 | [M17 — Automated daily DB backup (local disk, 3-deep retention)](archive/M17.md) |
| M18 | [M18 — Directional rate-limit drift alert:](archive/M18.md) |
| M19 | [M19 — Per-coin liquidity gate (stop the global liquidity halt)](archive/M19.md) |
| M21 | [M21 — Index-shock horizon alignment:](archive/M21.md) |
| M22 | [M22 — Depth-floor recalibration](archive/M22.md) |
| M23 | [M23 — Market-stress adaptive auto-resume](archive/M23.md) |
| M24 | [M24 — Live/paper open-fill wiring](archive/M24.md) |
| M25 | [M25 — Paper exploration enablement](archive/M25.md) |
| M26 | [M26 — Shadow counterfactual fill wiring](archive/M26.md) |
| M27 | [M27 — Decision data-capture completeness](archive/M27.md) |
| M28 | [M28 — Same-bar threshold recalibration + auto-resume wiring (DONE):](archive/M28.md) |
| M29 | [M29 — Paper funnel diagnosis + first-fill enablement (DONE):](archive/M29.md) |
| M30 | [M30 — Idiosyncratic-edge soak gate + idiosyncrasy observability (DONE):](archive/M30.md) |
| M31 | [M31 — Zombie positions & broken position-lifecycle (DONE):](archive/M31.md) |
| M32 | [M32 — Dashboard closed-positions history + Telegram position alerts (DONE):](archive/M32.md) |
| M34 | [M34 — Slot-reservation leak fix (normal-close CONFIRMED release + ADD multi-release + reconciliation slot-accounting invariant) (DONE):](archive/M34.md) |
| M33 | [M33 — Live exit enforcement (time-stop + paper protective simulation + entry cashflow) (DONE):](archive/M33.md) |

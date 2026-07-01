# xmom: cascade fallback, top_n increase, rebalance timing

**Date:** 2026-07-01  
**Status:** DONE — **M50b** (ADR 0050). Implementation + QA + review complete 2026-07-01.  
**Outcome:** [docs/milestone-log/archive/M50b.md](../../milestone-log/archive/M50b.md)

---

## Context

Dashboard smoke test (`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` → xmom, `strategy_versions` id=20)
showed the Decisions tab repeating the same rejection every ~5 min: `TAIKO/USDT:USDT`, `OPEN`,
`REJECTED`, `coin_book_too_thin`, `trend_initiation`. Zero trades over many consecutive cycles.
Investigation traced this to current config + design, not a bug — but surfaced three things worth
deciding before the next paper soak.

Params on `strategy_versions` id=20 were temporarily overridden to `rebalance_interval_ms=300000`
(5 min) for the smoke test; all other params (`top_n`, `min_universe_size`, `lookback_ms`) are still
schema defaults. **Must be reset to `{}` (24h defaults) before any real paper soak** — ADR 0050
changes are on top of that reset, not a replacement for it.

---

## How xmom worked before M50b (as-built at investigation time)

- **Universe:** `MomentumOrchestratorService.buildUniverse` pulls from `UniverseService` — top ~100
  symbols by 24h quote volume, floor $20M (`apps/engine/src/market-data/const/universeConsts.ts`).
  This is a **liquidity eligibility filter**, not the ranking signal.
- **Ranking:** `crossSectionalMomentumCore` sorts the eligible universe purely by **trailing return %
  over `lookback_ms`** (default 24h), strongest mover first, ties broken alphabetically for
  determinism. Volume plays no role in the ranking itself.
- **Selection:** took `top_n` (schema default **1**) off the top of the ranked list.
- **Per-cycle flow** (`MomentumOrchestratorService.rebalance`):
  1. Rank the universe, select `top_n`.
  2. Close any open position whose symbol fell out of the new selection.
  3. Open each newly-selected symbol not already open (`processOpen` → risk gate, incl.
     `coin_book_too_thin` at `RiskGateService.isBookTooThin`).
  4. **No fallback**: if a selected symbol is rejected by the risk gate, nothing replaced it in that
     cycle.
- **Cadence:** `RebalanceSchedulerService` registered `setInterval` at engine boot — no wall-clock
  alignment.

---

## Decisions (locked in ADR 0050)

All three decisions are implemented — see [ADR 0050](../../architecture/adr/0050-xmom-cascade-topn-rebalance-anchor.md)
and [M50b outcome](../../milestone-log/archive/M50b.md).

1. **Cascade fallback** — orchestrator walks full `ranked` list past gate rejects until `top_n` fills.
2. **`top_n` 1 → 3** — schema default; correlation labeling gap accepted for paper (H8 live blocker).
3. **Fixed 01:07 UTC cron** — `rebalance_interval_ms` advisory-only for time-stop net.

---

## Related

- ADR 0047 — `docs/architecture/adr/0047-portfolio-strategy-contract.md`
- ADR 0048 — `docs/architecture/adr/0048-rebalance-orchestrator.md`
- ADR 0050 — `docs/architecture/adr/0050-xmom-cascade-topn-rebalance-anchor.md`

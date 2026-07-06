# xmom paper soak: gate blockage analysis (liquidity + time-stop)

**Date:** 2026-07-01 (updated 2026-07-02)  
**Status:** CLOSED — **M51 shipped and smoke-tested 2026-07-02.** D1 (time-stop alignment) + D2 (paper liquidity relax) delivered; smoke test: 3 gate approvals in one cycle = first real end-to-end xmom lifecycle in 185 prior attempts. D3/D4 (depth=0 investigation, pre-gate-skip visibility) deferred; tech-debt entry added. Plan: [plans/archive/M51-xmom-paper-gate-unblock.md](../plans/archive/M51-xmom-paper-gate-unblock.md).  
**Context:** [2026-07-01-xmom-cascade-topn-rebalance-timing.md](done/2026-07-01-xmom-cascade-topn-rebalance-timing.md) (M50b / ADR 0050)  
**Companion:** [main-architector-paper-soak-fill-and-gate-analysis.md](done/main-architector-paper-soak-fill-and-gate-analysis.md) (M24–M27 gate/fill arc)

---

## TL;DR

Two soak eras, **different dominant blockers**:

| Era | When | Attempts | Dominant reject | Root cause |
|-----|------|----------|-----------------|------------|
| **Smoke** | 2026-07-01, 5-min override | 85 | `coin_book_too_thin` (91%) | Tier1 depth floor ($10k) vs thin momentum leaders |
| **Cron 01:07** | 2026-07-02 01:07 UTC, params `{}` | **100** (full universe) | **`time_stop_missing_or_invalid` (84%)** | `timeStopAtMs = 2× rebalance_interval` but gate allows only `1×` |

**P0 fix:** align momentum time-stop with the gate (`MomentumOrchestratorService` sets
`timeStopAtMs: nowMs + rebalance_interval_ms * 2`; `buildGateStrategyParams` sets
`time_stop_minutes = rebalance_interval_ms`; `RiskGateService.checkTimeStop` rejects when
`timeStopAtMs > nowMs + time_stop_minutes`). With default 24h rebalance, **every deep-book symbol
fails** after the thin top ranks.

**P1 fix:** paper-only tier2 liquidity relax (depth **>$2,500**, spread **≤0.30%**) for the **16%
of cron attempts** (and smoke-era leaders) blocked on spread/depth — **not sufficient alone** for the
01:07 cron run.

---

## Runtime context

| Setting | Value |
|---------|-------|
| `EXCHANGE_ENV` | `paper` |
| `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` | `20` (xmom) |
| `strategy_versions` id=20 `params` | `{}` (defaults: `top_n=3`, `rebalance_interval_ms=24h`) |
| `MAX_EXPOSURE_PER_COIN_USDT` | `$500` |
| `MAX_SAME_DIRECTION_EXPOSURE_USDT` | `$1,500` |
| `MAX_OPEN_POSITIONS` | `3` |
| `PAPER_RELAX_MARKET_STRESS` | `true` |
| Rebalance cadence | ADR 0050 fixed cron `7 1 * * *` UTC (+ manual `pnpm rebalance:trigger`) |

**Current tier1 per-coin liquidity gates** (`apps/engine/src/risk/const/riskConsts.ts`):

- Spread ceiling: **0.15%** (`TIER_SPREAD_CEILING_PCT.tier1`)
- Depth floor (10bps, one-sided): **$10,000** (`COIN_DEPTH_FLOOR_10BPS_USDT.tier1`)

`PAPER_RELAX_MARKET_STRESS` (ADR 0042) does **not** relax per-coin spread/depth.

**Gate check order** (`RiskGateService.firstFailingCheck`): halts → **spread → depth** → stateful
limits (includes **time-stop**). Liquidity is evaluated before time-stop.

**Cascade when all opens fail** (ADR 0050): walks the **entire ranked universe** (up to ~100
symbols) in one cycle until `top_n` slots fill — each failed open is logged as a decision row.

---

## Era A — smoke test (5-min `rebalance_interval_ms` override)

Source: `decisions` where `strategy_version_id = 20` and `ts < 2026-07-02 01:00 UTC`.

| Metric | Value |
|--------|-------|
| Total gate attempts | **85** |
| `coin_book_too_thin` | **77** (91%) |
| `spread_too_wide` | **8** (9%) |
| Approved | **0** |
| Distinct symbols at gate | **2** (NFP, TAIKO) |

Only **two symbols** reached the gate per cycle; ranks 3+ mostly **pre-gate skip** (no ATR/sizing —
no decision row). Both gate symbols are **tier1**.

### Depth distribution (`coin_book_too_thin`, n=77)

| Percentile | 10bps depth (USDT) |
|------------|-------------------|
| p10 | **$604** |
| p25 | **$1,103** |
| **p50** | **$1,974** |
| p75 | **$3,314** |
| p90 | **$3,567** |
| **max** | **$7,818** |

| Symbol | n | depth p50 | depth max | spread p50 |
|--------|---|-----------|-----------|------------|
| NFP | 56 | **$2,557** | $7,818 | 0.046% |
| TAIKO | 21 | **$1,581** | $3,314 | 0.076% |

**0 rows** depth above $9k. Spread is not the blocker on thin-book rows (median ~0.05%).

### `spread_too_wide` (8 rows, all NFP)

Spread **0.21–0.24%**; every row also has **`book_depth_10bps_usdt = 0`** (feed/timing).

### Pass simulation (smoke era, n=85)

| Rule set | Would pass |
|----------|------------|
| Current tier1 | **0** |
| Tier2 (spread ≤0.30%, depth >$2,500) | **29** (34%) |
| spread ≤0.30%, depth >$2,000 | **38** (45%) |

---

## Era B — first scheduled cron rebalance (2026-07-02 01:07 UTC)

Source: `decisions` where `strategy_version_id = 20` and `ts` in `[01:06, 01:08) UTC`.

After params reset to `{}` and ~24h market-data warmup, **all ~100 universe symbols** had
price/ATR/sizing. Cascade walked the **full ranked list** (0 fills → 100 decision rows).

| Reason | n | % | depth p50 | spread p50 |
|--------|---|---|-----------|------------|
| **`time_stop_missing_or_invalid`** | **84** | **84%** | **$73,326** | 0.014% |
| `coin_book_too_thin` | 15 | 15% | $2,034 | 0.051% |
| `spread_too_wide` | 1 | 1% | $0 | 0.208% |
| **Approved** | **0** | | | |

### Cascade walk by approximate rank (`signal_score ≈ round(100/rank)`)

| Rank band | Primary reject |
|-----------|----------------|
| **1–7** | Liquidity (`coin_book_too_thin` / `spread_too_wide`) — thin momentum leaders |
| **8–100** | **`time_stop_missing_or_invalid`** — deep books, gate passes spread/depth |

Liquidity-blocked symbols at 01:07 (16 total): TLM, TAIKO, NFP (spread), M, RIF, BASED, BTW, ZBT,
NOM, SLX, BEAT, IN, SYN, BAS, TAC, DYDX — mix of tier1/tier2, depth **$597–$4,855**.

### If time-stop were aligned (hypothetical)

| Cohort | n | Would pass tier1 liquidity | Would pass tier2 liquidity |
|--------|---|---------------------------|---------------------------|
| `time_stop_missing_or_invalid` rows | 84 | **73** | **84** |
| Liquidity rejects only | 16 | 0 | **5** |

**84% of cron attempts are blocked by a config mismatch, not liquidity.** Tier2 liquidity relax
alone would unlock at most **~5** of 100 cron rows (the thin top ranks); fixing time-stop unlocks
**up to 3** deep-book fills per cycle (cascade stops at `top_n=3`).

### Time-stop mismatch (code)

```387:387:apps/engine/src/strategy/service/MomentumOrchestratorService.ts
                timeStopAtMs: nowMs + params.rebalance_interval_ms * 2,
```

```543:543:apps/engine/src/strategy/service/MomentumOrchestratorService.ts
            time_stop_minutes: Math.ceil(params.rebalance_interval_ms / MS_PER_MINUTE),
```

```1303:1306:apps/engine/src/risk/service/RiskGateService.ts
        const maxAllowedMs = context.nowMs + context.params.time_stop_minutes * MS_PER_MINUTE;

        if (timeStopAtMs <= context.nowMs || timeStopAtMs > maxAllowedMs) {
            return RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID;
```

With default `rebalance_interval_ms = 86_400_000` (24h): intent proposes **48h** hold; gate allows
**24h** max → always rejects after liquidity checks pass.

The **2× margin** is intentional (ADR 0048 — enforcer must not fire before next rebalance), but the
gate ceiling must accommodate it (e.g. `time_stop_minutes ≥ 2 × rebalance_interval`, or xmom-specific
`checkTimeStop` waiver).

---

## Combined dataset (both eras)

| Era | `coin_book_too_thin` | `spread_too_wide` | `time_stop_missing_or_invalid` | Total |
|-----|----------------------|-------------------|-------------------------------|-------|
| Smoke | 77 | 8 | 0 | 85 |
| Cron 01:07 | 15 | 1 | 84 | 100 |
| **All** | **92** | **9** | **84** | **185** |

---

## Book-consumption check ($500 max per coin)

| Floor | $500 order as % of 10bps book | Assessment |
|-------|-------------------------------|------------|
| $10,000 (tier1) | 5% | Conservative — smoke leaders fail; cron deep books pass |
| **$2,500 (tier2)** | **20%** | Acceptable for paper pipeline validation |
| $2,000 | 25% | Optional second step |
| $1,500 | 33% | Too aggressive for default |

---

## Recommendations (priority order)

### P0 — Fix time-stop gate alignment for xmom (blocks 84/100 at 01:07)

Align `buildGateStrategyParams.time_stop_minutes` with the **2× rebalance** intent (or add an
xmom-specific `checkTimeStop` path). **Must land before or with** liquidity relax — otherwise cron
rebalance will keep walking 100 symbols and rejecting deep books.

### P1 — Tier2 liquidity for paper xmom (blocks top ~7 ranks + smoke leaders)

Paper-only: depth **>$2,500**, spread **≤0.30%**. Helps smoke-era NFP/TAIKO and cron ranks 1–7;
**5/16** liquidity rejects pass at tier2 on the 01:07 sample.

Implementation: `PAPER_RELAX_PER_COIN_LIQUIDITY` env flag (paper-only, default off) + ADR + tests.

### P2 — Do not lower tier1 floor to ~$8k

Max observed thin-book depth **$7,818** in smoke — negligible gain.

### P3 — Investigate depth=0

`spread_too_wide` rows (NFP at 01:07 and smoke) have **depth=0** at checkpoint.

### P4 — Pre-gate skip visibility

Smoke era logged only 2 symbols; cron logged 100. Dashboard/decisions should surface
`momentum open skipped — no price/ATR/instrument/sizing` as rows or metrics.

---

## Expected outcome after fixes

1. **Time-stop fix:** cron rebalance should approve **up to 3** deep-book momentum leaders per
   cycle (cascade stops at `top_n`), not walk 100 symbols to time-stop reject.
2. **Tier2 liquidity:** improves odds when top ranks are thin alts (NFP/TAIKO pattern).
3. **Not guaranteed:** 3 positions every day — rank-1 may still be illiquid; cascade continues.

---

## Next steps

1. Implement **P0 time-stop alignment** + tests
2. Implement **P1 paper liquidity relax** + ADR
3. Re-run `pnpm rebalance:trigger` or wait for next 01:07 cron; expect ≤3 gate approvals, not 100 rejects
   - **Note (M50c/ADR 0050):** M50c formalized `pnpm rebalance:trigger` CLI + endpoint (2026-07-02); can now re-test without ad-hoc means
4. Investigate depth=0 on spread rejects

---

## SQL reference (repro)

```sql
-- Combined era breakdown
SELECT
  CASE WHEN ts < '2026-07-02 01:00:00+00' THEN 'smoke' ELSE 'cron_0107' END AS era,
  reason, COUNT(*) AS n
FROM decisions WHERE strategy_version_id = 20
GROUP BY 1, 2 ORDER BY 1, n DESC;

-- Cron 01:07 window
SELECT reason, COUNT(*) AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY (market_snapshot->>'book_depth_10bps_usdt')::numeric) AS depth_p50
FROM decisions
WHERE strategy_version_id = 20
  AND ts >= '2026-07-02 01:06:00+00' AND ts < '2026-07-02 01:08:00+00'
GROUP BY reason ORDER BY n DESC;

-- Hypothetical: time_stop rows that would pass tier1 liquidity
SELECT COUNT(*) FILTER (WHERE spread <= 0.15 AND depth > 10000) AS pass_tier1
FROM (
  SELECT (market_snapshot->>'book_depth_10bps_usdt')::numeric AS depth,
         (market_snapshot->>'bid_ask_spread_pct')::numeric AS spread
  FROM decisions
  WHERE strategy_version_id = 20
    AND ts >= '2026-07-02 01:06:00+00' AND ts < '2026-07-02 01:08:00+00'
    AND reason = 'time_stop_missing_or_invalid'
) t;
```

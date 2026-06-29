> **EXP-010 — REJECTED** | 2026-06-29 | [back to index](README.md)

# EXP-010 — Does `forced_exhaustion` (mean-reversion fade) have better edge than `trend_initiation` (momentum follow)?

## 1. Summary

**Hypothesis:** VWAP-deviation signals may suit mean-reversion (fade the move) better than
momentum (follow it), because the bot always enters *after* a deviation. If the
`forced_exhaustion → meanReversionCore` path has a higher win rate than the
`trend_initiation → momentumCore` path studied in EXP-001–009, it reframes the strategy
direction.

**Verdict: REJECTED.** `forced_exhaustion` does not have better edge — it has **materially
worse** win rate than `trend_initiation` in every live data source, and the deficit is
robust on the only version with a usable sample (v3):

| Source | trend_initiation WR | forced_exhaustion WR | Winner |
|---|---|---|---|
| Live positions, pooled (all versions) | 24.1% (n=58) | **10.3%** (n=39) | trend_initiation |
| Live positions, v3 only | 27.1% (n=48) | **11.4%** (n=35) | trend_initiation |
| Live positions, v16 only | 10.0% (n=10) | **0.0%** (n=4) | trend_initiation |
| Shadow, traded, pooled | ~4% TP (≈49 traded) | **~3% TP** (≈29 traded) | both terrible, fade worse |
| Backtest v16 (350 trades) | 23.4% (n=350) | **no trades emitted** | n/a (harness gap) |

This is **not** a volume problem. In live v16, `forced_exhaustion` is *opened at a higher
rate* than `trend_initiation` (28.8% open-rate vs 18.5%) and generated ~14 signals/day. The
path is fully wired and routing trades; it simply loses more often. Breakeven WR at the
shared R:R of 1.5 is ~40%; `forced_exhaustion` delivers 10.3% — a 30 pp shortfall, larger
than momentum's own ~16 pp shortfall.

**Strategic implication:** the VWAP-deviation entry edge is weak in **both** directions
(follow *and* fade). The binding constraint is entry/regime selectivity, not signal
direction. Do not pivot the strategy to a mean-reversion-first router.

## 2. Setup

**Data sources**
- **Backtest:** v16 JSON, 350 trades, 2026-05-30 → 2026-06-29 (`backtest-v16.json`).
- **Live positions:** `positions` table, closed positions grouped by `flow_type_at_entry`.
  All 222 closed live positions belong to v3 (id 3, 208) and v16 (id 16, 14).
- **Live decisions:** `decisions` table, v16 signal volume by `flow_type` × `action`,
  window 2026-06-25 → 2026-06-29 (~4 days; M47 live since 2026-06-25).
- **Shadow:** `shadow_decisions`, counterfactual fills by `shadow_version` × `flow_type`.
- **Code:** `apps/engine/src/strategy/strategies/meanReversionCore.ts`,
  `momentumCore.ts`, `const/strategyConsts.ts`.

**Caveats**
- **Backtest cannot validate `forced_exhaustion`.** The v16 backtest emitted **zero**
  `forced_exhaustion` trades — `perFlowType` contains only `flow:trend_initiation` (350/350).
  Live v16 routes 59 `forced_exhaustion` signals in the same window, so the backtest harness
  cannot reproduce the live flow-type mix (see §3.2). All `forced_exhaustion` evidence here
  is **live + shadow only**.
- **Absolute live WR/net are partly retroactive-code figures** (M47 live only from
  2026-06-25; v3 positions pre-date it). Per the registry methodology note, treat *relative*
  flow-type rankings as trustworthy and absolute dollars as indicative.
- **Shadow sizes off virtual per-version equity**, not the live sizer — use sign and WR, not
  dollar magnitude.
- n for `forced_exhaustion` is modest (39 pooled live; 35 in v3). Sufficient to reject a
  "materially better" claim, not to publish a precise expectancy.

## 3. Results

### Task 1 — Flow-type volume audit (live v16 decisions, 2026-06-25 → 2026-06-29)

| flow_type | open | skip | total | open-rate | ~signals/day |
|---|---|---|---|---|---|
| trend_initiation | 17 | 75 | 92 | 18.5% | ~22 |
| forced_exhaustion | 17 | 42 | 59 | **28.8%** | ~14 |
| catalyst_risk | 0 | 444 | 444 | 0.0% | ~106 (all skipped — correct) |
| market_beta | 2 | 4 | 6 | 33.3% | ~1.4 |

`forced_exhaustion` is **actively routing** in v16: 59 signals, 17 opens, the *highest*
open-rate of any tradeable flow type. It is neither absent nor starved. `catalyst_risk` is
correctly skipped 444/444 (confirms the prior-session decision).

### Task 2 — Backtest `forced_exhaustion` performance

**Zero `forced_exhaustion` trades in the 350-trade v16 backtest.** `flow_counts =
{'trend_initiation': 350}`; `perFlowType` lists only `flow:trend_initiation`
(WR 23.42%, net −$535.69, PF 0.24). The backtest replay classifies **every** trigger as
`trend_initiation`, so the momentum/fade comparison is impossible in-sim.

This is a **live/backtest flow-classification mismatch**, not signal scarcity: live v16
generates ~14 `forced_exhaustion` signals/day, but the backtest harness produces none over a
30-day, ~300-symbol replay. The likely cause is that the backtest's flow classifier lacks the
OI/funding inputs that `classifyFlowType` needs to ever leave the `trend_initiation` default.
**Flagged as a data-integrity blocker** for any backtest-based flow-type work (see §7).

### Task 3 — Live positions by flow_type (pooled, all closed)

| flow_type | n | tp | sl | ts | fc | WR | time-stop % | net PnL | avg PnL |
|---|---|---|---|---|---|---|---|---|---|
| catalyst_risk | 122 | 33 | 16 | 68 | 1 | 27.0% | 55.7% | −$195.52 | −$1.60 |
| trend_initiation | 58 | 14 | 9 | 32 | 3 | 24.1% | 55.2% | −$23.50 | −$0.41 |
| **forced_exhaustion** | 39 | 4 | 3 | 27 | 3 | **10.3%** | **69.2%** | −$24.82 | **−$0.64** |
| market_beta | 3 | 2 | 1 | 0 | 0 | 66.7% | 0.0% | −$5.71 | −$1.90 |

`forced_exhaustion` is the **worst tradeable flow on win rate** (10.3%), has the **highest
time-stop dominance** (69.2% vs momentum's 55.2%), and the **worst per-trade expectancy of
the two studied paths** (−$0.64 vs −$0.41). The fade neither reaches its VWAP-retrace TP nor
gets cleanly stopped — it predominantly sits and time-stops near flat (27 of 39).

### Task 4 — Historical flow_type comparison across versions

| version | flow_type | closed | tp | WR | net PnL |
|---|---|---|---|---|---|
| v3 (id 3) | trend_initiation | 48 | 13 | **27.1%** | −$20.02 |
| v3 (id 3) | forced_exhaustion | 35 | 4 | 11.4% | −$17.04 |
| v16 (id 16) | trend_initiation | 10 | 1 | **10.0%** | −$3.48 |
| v16 (id 16) | forced_exhaustion | 4 | 0 | 0.0% | −$7.78 |

In **both** versions that carry both flows, `trend_initiation` beats `forced_exhaustion` on
WR (27.1% vs 11.4% in v3, the only version with usable n; 10.0% vs 0.0% in v16). The fade
**never historically outperformed** the follow.

### Task 5 — Signal frequency and selectivity

`forced_exhaustion` is **common-but-losing**, not rare:
- v16 decisions: 59 signals, 28.8% open-rate (higher than momentum's 18.5%).
- v3 decisions: 147 opens / 235 skips = 382 signals, 38.5% open-rate.
- The path's `meanReversionCore` gating (regime suppression, idiosyncratic-trap, mandatory
  exhaustion confirmation, M47 degenerate-geometry skip) already rejects ~60–70% of triggers,
  yet the survivors still win only ~10–11%. The selectivity filters are not the bottleneck;
  the fade thesis itself does not pay at this horizon/RR.

### Task 6 — `meanReversionCore` mechanics vs `momentumCore`

| Aspect | momentumCore (trend_initiation) | meanReversionCore (forced_exhaustion) |
|---|---|---|
| Direction | follow the deviation | **fade** it (`resolveFadeSide`) |
| SL anchor | VWAP-distance ‖ref − vwapSession‖ | **wick-anchored** structural stop just beyond the deviation wick (`structural_stop_wick_buffer_pct`), hard-capped, then M47 slCap-capped |
| TP target | `max(baseLeg, atr14 × min_rr)` (ATR-relative) | **VWAP-anchored half-retrace**: `vwap + (price − vwap) × 0.5` — a *partial* move back to VWAP, deliberately conservative |
| TP rebase | eligible (ref ± ATR) | **not** rebase-eligible (`tpRebaseEligible: false`) — VWAP anchor would be corrupted by re-anchoring |
| M47 degenerate check | yes (slDist × min_rr R:R floor) | **yes** — wrong-side-VWAP skip *and* noise-floor skip (`slCapDistance < slFloorDistance`) |
| R:R floor (`min_rr`) | 1.5 | **1.5 (same)** |
| Entry gating unique to path | — | regime-suppress counter-trend fades, idiosyncratic-trap skip, **mandatory exhaustion confirmation** (band re-entry / volume deceleration / OI-not-rising) |

Key structural read: the mean-reversion TP is only **half** the deviation back toward VWAP
(offset 0.5), so `tpDist` is often small; the shared `min_rr = 1.5` then caps the stop to
`tpDist / 1.5`, producing a *tight* stop against a *counter-trend* entry. That geometry plus
the 69% time-stop rate explains the outcome: most fades do not retrace far enough to hit the
near TP within the hold window, and they expire at time-stop near flat — the worst kind of
"not wrong fast, just never right."

### Task 7 — Verdict comparison table

| Dimension | trend_initiation | forced_exhaustion | Advantage |
|---|---|---|---|
| Backtest WR (v16) | 23.4% (n=350) | no trades emitted (harness gap) | n/a |
| Live WR, pooled | 24.1% (n=58) | **10.3% (n=39)** | trend_initiation |
| Live WR, v3 (best n) | 27.1% (n=48) | **11.4% (n=35)** | trend_initiation |
| Shadow TP-rate, pooled | ~4% (≈49 traded) | **~3% (≈29 traded)** | trend_initiation (both poor) |
| Signal frequency (v16) | ~22/day, 18.5% open | ~14/day, **28.8% open** | forced_exhaustion (more routed) |
| Time-stop dominance | 55.2% | **69.2%** | trend_initiation (lower) |
| Per-trade expectancy (live) | −$0.41 | **−$0.64** | trend_initiation |
| Net PnL trend | negative | **more negative per trade** | trend_initiation |

**`forced_exhaustion` is well-utilised but worse**, not under-utilised or absent. The only
axis on which it "wins" is open-rate — i.e., it is *traded more*, which makes its lower WR
*more* costly, not less.

## 4. Verdict

**REJECTED.** Decision rule: SUPPORTED required ≥35% WR with n ≥ 20 across ≥2 sources.
`forced_exhaustion` delivers **10.3% pooled / 11.4% in v3** (n = 39 / 35) — far below the
35% bar and below `trend_initiation` in every live and shadow source. The fade path performs
*worse* than the momentum path that EXP-001–009 already found sub-breakeven.

## 5. Strategic implication

This is the important finding: **the VWAP-deviation trigger lacks edge in both directions.**
- Momentum (follow): 23–27% WR, ~55% time-stop, sub-breakeven (EXP-001–009).
- Mean-reversion (fade): 10–11% WR, ~69% time-stop, *worse*.

Direction is therefore **not** the lever. Switching from follow to fade does not rescue the
strategy; if anything it degrades it. This corroborates EXP-001/002/003/009: the binding
constraint is **entry/regime selectivity and trigger quality**, not the follow-vs-fade
decision applied after the trigger fires.

Concretely: do **not** build a mean-reversion-first router, do **not** invert v3 to fade by
default, and do **not** treat `forced_exhaustion` as an under-exploited opportunity. The
empirically-locked design (`flow_type` decides fade/follow/skip per regime) is correctly
sending most volume to skip and the rest to a weak-but-less-weak momentum path; flipping that
balance toward fade would lose more.

## 6. What this rules out

- **Do not reframe the strategy around mean-reversion.** Fading the deviation has lower WR,
  higher time-stop dominance, and worse expectancy than following it, on n = 39 live (n = 35
  in the one version with a usable sample) and corroborated in shadow.
- **Do not treat `forced_exhaustion` as volume-starved.** It routes ~14 signals/day at a
  28.8% open-rate in v16 (higher than momentum's). The problem is edge, not throughput.
- **Do not blame the `meanReversionCore` gating.** Regime-suppress, idiosyncratic-trap,
  mandatory exhaustion confirmation, and the M47 degenerate-geometry skip already reject most
  triggers; survivors still win ~10%. Tightening these will not turn the fade green.
- **Do not retune `min_rr` or the VWAP TP offset to fix it.** This is the EXP-002 lesson
  applied to the fade: geometry tuning cannot close a 30 pp WR-to-breakeven gap.

## 7. Recommended next action

1. **~~File a backtest data-integrity ticket~~ FIXED 2026-06-29.** Root cause identified and
   patched in `BacktestRunnerService.ts`. `buildOiIndex` was keying OI rows by raw millisecond
   timestamps (e.g., `19:15:31.435 → ms`), but `resolveOpenInterestAt` searched by exact 5m bar
   boundaries (`19:15:00`). The keys never aligned → all OI lookups returned `null` →
   `oiChange5mPct` was always 0 → `classifyFlowType` never satisfied the `≤ −0.5%` threshold
   → 0 `forced_exhaustion` in 350 replay trades. Fixed by replacing the Map with a sorted
   `IOiEntry[]` and binary-searching for "most recent sample at-or-before T" with a 60-min
   staleness guard. See `tech-debt.md M25`. **EXP-001–009 backtests were run on the broken
   harness; re-running them post-fix may produce a different flow-type mix and adjusted absolute
   WRs. Relative rankings should be similar.**
2. **Close the "direction" lever.** With both follow and fade sub-breakeven, stop testing
   direction permutations. The remaining open levers from EXP-009 are: (a) a longer
   same-version forward soak to grow n on the price-positive `tier1 ∩ trending` cohort, and
   (b) a step back to whether the VWAP-deviation *trigger itself* has any edge worth trading
   — the EXP-010 result (weak in both directions) is mild evidence that it may not, in the
   current regime.
3. **No code change to routing.** `forced_exhaustion` routing is working as designed; the
   design is simply not profitable. Leave it wired (it is a cheap empirical probe) but do not
   lean into it.

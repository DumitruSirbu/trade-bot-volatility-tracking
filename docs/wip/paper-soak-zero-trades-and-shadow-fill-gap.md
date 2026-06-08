# Paper Soak: Zero Live Trades & Shadow Fill Gap

**Date:** 2026-06-06  
**Status:** WIP — analysis + recommendations. **Tier A/B partially landed (M25); Tier C → M26; Tier D unchanged.** See [Milestone coverage](#milestone-coverage). Moves to [`docs/wip/done/`](done/) when no OPEN/PLANNED rows remain.  
**Trigger:** Operator wants simulated paper transactions (losses acceptable) but soak shows only skips/rejects, no `positions` or `transactions` rows.

---

## Milestone coverage

Tracked against [`docs/milestone-log.md`](../milestone-log.md). Parent prioritized set: [main-architector-paper-soak-fill-and-gate-analysis.md](main-architector-paper-soak-fill-and-gate-analysis.md) (P0–P5).

| WIP recommendation | Maps to | Milestone | Log status | Notes |
|--------------------|---------|-----------|------------|-------|
| Paper open fill (empty ticks → missed opens) | P0 | [M24](../plans/M24-paper-open-fill-wiring.md) | **DONE** | Prerequisite for any paper `positions` row |
| Activate v2 momentum (`ACTIVE_STRATEGY_VERSION_ID=3`) | P1 / Tier A | M25 | **DONE** | Config + restart |
| Param SQL / strategy tuning (Tier A) | P1 | M25 | **DONE** | Operator `.env` / DB, not engine code |
| `PAPER_RELAX_MARKET_STRESS` (Tier B) | P2 | M25 | **DONE** | ADR 0042; paper-gated |
| Raise slots / capital (Tier A/B) | P3 | M25 | **PARTIAL** | Exposure headroom only; **3-slot ceiling kept** |
| Shadow bar high/low + `tick_aggregates` (Tier C) | P4 | [M26](../plans/M26-shadow-counterfactual-fill-wiring.md) | **PLANNED** | Supersedes minimal bar-only fix in this doc |
| Decision capture gaps (not in Tier table) | P5 | [M27](../plans/M27-decision-data-capture-completeness.md) | **PLANNED** | Migrations required |
| M23 breadth auto-resume (context) | — | M23 | **DONE** | Referenced in operator config table |
| Tier D — avoid (live keys, v3 hybrid, etc.) | — | — | **N/A** | Still valid guidance |

**Suggested next actions (§ below):** items 1–3 largely **superseded by M24/M25 deploy checklist**; item 4 (shadow PnL) still blocked on **M26**.

---

## Executive summary

1. **Paper mode is wired correctly** (`EXCHANGE_ENV=paper`, `EXECUTION_MODE=live`). The blocker is the decision funnel, not missing paper fills.
2. **Live v1 has never received a single risk-gate approval** — 350 strategy-level open intents in 14 days, **0** approvals, **0** positions.
3. **Shadow v2/v3 prove strategies would trade** on the same event tape (583 and 216 open intents respectively), but shadow **fills are 100% missed** — virtual ledger never opens, so counterfactual PnL is unavailable.
4. **Shadow data is partially useful today** (strategy routing, flow-type comparison, v2 vs v3 selection) but **not useful for trade outcomes** until shadow fills are fixed.
5. **Recommended path:** activate v2 for live paper + relax live risk gate; separately fix shadow bar high/low (or tick) fill wiring for counterfactual PnL.

---

## Current operator config (`.env`)

| Variable | Value | Notes |
|----------|-------|-------|
| `EXCHANGE_ENV` | `paper` | Simulated exchange client |
| `EXECUTION_MODE` | `live` | Not dry-run — fills would run if gate approved |
| `ACTIVE_STRATEGY_VERSION_ID` | `2` | DB id → **v1 mean-reversion** (not version number 2) |
| `MARKET_STRESS_AUTO_RESUME_ENABLED` | `true` | M23 breadth auto-resume (paper default) |
| `MAX_OPEN_POSITIONS` | `1` | Live restricted profile |
| `ACCOUNT_CAPITAL_USDT` | `500` | Sizing capital |

Strategy versions in DB:

| `strategy_versions_id` | `version` | `status` | `direction` |
|------------------------|-----------|----------|-------------|
| 1 | 0 | shadow | mean_reversion (baseline) |
| 2 | 1 | **active** | mean_reversion (v1) |
| 3 | 2 | shadow | momentum (v2) |
| 4 | 3 | shadow | hybrid (v3) |

---

## Live funnel analysis (Postgres, last 14 days)

### Decisions table (`decisions`)

| `action` | Count | Meaning |
|----------|------:|---------|
| `skip` | 761 | Strategy rejected before risk gate |
| `open` | 350 | Strategy emitted open intent → reached gate |

**Gate approvals:** **0** (no row with a strategy reason like `mean_reversion_fade` / `momentum_follow` after gate pass).

**Positions / transactions:** **0** open, **0** closed, **0** transaction rows.

### Strategy skips (live v1)

| `reason` | Count |
|----------|------:|
| `regime_suppressed` | 348 |
| `idiosyncratic_trap` | 272 |
| `move_out_of_band` | 98 |
| `no_exhaustion_confirmation` | 43 |

v1 mean-reversion is intentionally conservative: fade only after exhaustion confirmation; no fade against trend; no fade on idiosyncratic + rising OI + elevated volume.

Note: `require_exhaustion_confirmation: true` exists in `strategy_versions.params` but is **not wired** in `meanReversionCore.ts` — exhaustion is always enforced in code.

### Gate rejections (stored as `action=open` + reject `reason`)

Dashboard shows these as `action=open`; the `reason` column carries the gate outcome.

| `reason` | Count | Share of gate attempts |
|----------|------:|------------------------|
| `global_halt` | 232 | 66% |
| `market_stress` | 42 | 12% |
| `sl_outside_liquidation` | 33 | 9% |
| `coin_book_too_thin` | 21 | 6% |
| `no_eligible_slot` | 13 | 4% |
| `exposure_cap_per_coin` | 7 | 2% |
| `below_universe_floor` | 2 | <1% |

**Dominant blocker:** day-level halts (`global_halt` / `market_stress`). Signals arriving while `risk_state.is_halted=true` are rejected even for deep tier-1 names.

### `risk_state` (recent UTC days)

| Date | `is_halted` | `halt_reason` | `trades_count` |
|------|-------------|---------------|--------------|
| 2026-06-06 | false | — | 0 |
| 2026-06-05 | true | `market_stress:breadth` | 0 |
| 2026-06-04 | false | — | 0 |
| 2026-06-03 – 06-01 | true | `market_stress` | 0 |
| 2026-05-31 | true | `market_stress` | 0 |

M23 auto-resume helps **breadth-only** halts (`market_stress:breadth`). BTC/ETH shock, OI, funding, spread, and multi-leg stress still full-day lock.

### Today (2026-06-06) sample

Still no approvals. Gate rejections include `global_halt` (mid-day, before resume), `sl_outside_liquidation`, `coin_book_too_thin`, `market_stress`.

---

## Decision funnel (code path)

```
Ticker / 5m bar close
  → evaluateTrigger (2.5σ, 2× volume, tier move bands)   [hardcoded in triggerConsts.ts]
  → classifyFlowType + computeSignalScore
  → activeStrategy.evaluate (v1/v2/v3)
      → skip OR open intent
  → PositionSizer / buildOrderIntent
  → [BTC-correlated bar buffer: best candidate only]
  → RiskGateService.evaluate  ← live chokepoint
      → approve → order.intent.approved → PaperFillSimulator → position
      → reject  → persisted as action=open + reject reason
```

Parallel path after live v1 routes:

```
StrategyService → ShadowStrategyOrchestratorService (v0/v2/v3 shadow)
  → shadow strategy.evaluate
  → VirtualPositionLedgerService.evaluateGates (minimal)
  → HistoricalFillAdapter.simulate (empty ticks today → 100% missed)
  → shadow_decisions row
  → tryOpen only if !simulatedFill.missed
```

---

## Shadow decisions analysis (Postgres, last 14 days)

### Volume by version

| Version | `action=open` | `action=skip` | `gate_allowed=false` |
|---------|--------------:|--------------:|---------------------:|
| v0 (baseline) | 0 | 1,111 | 0 |
| **v2 (momentum)** | **583** (52%) | 528 | 0 |
| **v3 (hybrid)** | **216** (19%) | 895 | 0 |
| **Total rows** | | **3,333** | |

Same ~1,111 unique `event_id` values across versions — valid same-tape comparison.

### By flow type (strategy routing)

| Flow type | v2 | v3 |
|-----------|----|----|
| `catalyst_risk` | 375 open / 336 skip | **711 skip / 0 open** |
| `trend_initiation` | 108 open / 105 skip | 108 open / 105 skip |
| `forced_exhaustion` | 99 open / 80 skip | 108 open / 71 skip |
| `market_beta` | 1 open / 7 skip | 8 skip |

**Conclusion:** v2 momentum **follows** catalyst pumps (majority of shadow opens). v3 **skips all** `catalyst_risk` via `flow_routed_skip`. For exploration volume, **v2 ≫ v3**.

### Shadow fills — the gap

| Metric | v2 | v3 |
|--------|----|----|
| Rows with `simulated_fill` | 583 | 132 |
| `missed: false` | **0** | **0** |
| `missed: true` | 583 | 132 |
| Rows with `qty` populated | 578 | 131 |
| Virtual ledger open positions after open | **0** | **0** |

Every `simulated_fill` sample: `{ "missed": true, "entryPrice": "0", "lowFidelity": true }`.

**Root cause** (`ShadowStrategyOrchestratorService.simulateShadowFill`):

```typescript
barHigh: entryPrice,
barLow: entryPrice,
ticks: [],
bookSnapshot: null,
```

Shared fill model (`missedFillDetector.ts`): **empty ticks + limit policy → missed** (ADR 0015 C6 conservatism). `tryOpen()` only runs when `!simulatedFill.missed`, so virtual ledger never holds positions.

### Shadow gate vs live gate

Shadow `VirtualPositionLedgerService.evaluateGates` only checks:

- Halted (consecutive-loss virtual halt)
- `max_trades_per_day` (3)
- `max_open_positions` (1)

It does **not** run live `RiskGateService` checks:

- No `market_stress` / `global_halt`
- No `coin_book_too_thin`, `spread_too_wide`, `oi_unavailable`
- No `sl_outside_liquidation`
- No depth floors, exposure caps, slot model (live)

Constants `SHADOW_GATE_SKIP_MARKET_STRESS` and `SHADOW_GATE_REQUIRE_EXHAUSTION_CONFIRMATION` are defined in `strategyConsts.ts` but **not enforced** in `evaluateGates()`.

Shadow therefore answers: *“Would this strategy say OPEN under a minimal virtual gate?”* — not *“Would live risk gate approve?”*

---

## Is shadow data useful?

### Three layers

| Layer | What it measures | Status |
|-------|------------------|--------|
| **1 — Strategy decision** | OPEN vs SKIP, flow routing, sizing intent | ✅ Working |
| **2 — Fill + virtual ledger** | Entry price, positions, closes | ❌ 100% missed |
| **3 — PnL / promotion gate** | Expectancy, v1 vs v2/v3 bootstrap | ❌ Blocked on Layer 2 |

### Useful today

- Same-event strategy comparison (v1 skip vs v2 open on shared `event_id`)
- Relative trade appetite: v2 (52%) vs v3 (19%) vs live v1 (0 approvals)
- Flow-type routing evidence (v3 skips catalyst; v2 trades it)
- Choosing **v2 over v3** for paper activation
- Debugging funnel / regime / trap behaviour
- Infrastructure validation (orchestrator, idempotency, schema)

### Not useful today (until fills fixed)

- Simulated PnL, win rate, expectancy, Sharpe
- M11b soak exit: *“active version beats shadow v2/v3”*
- ADR 0018 paired circular-block bootstrap
- Virtual consecutive-loss / max-trades-per-day behaviour (no opens → no closes)
- `lowFidelity`-excluded ranking (all fills missed + `lowFidelity: true`)

ADR 0029 and M11a plan explicitly anticipate `lowFidelity: true` on shadow fills until bar/tick data is wired; the current 100% miss rate is **worse than lowFidelity** — it is **zero realised shadow trades**.

---

## Trigger params note

Live detection uses **engine constants**, not DB `strategy_versions.params`:

| Param | DB seed | Live (`triggerConsts.ts`) |
|-------|---------|----------------------------|
| `vwap_sigma_trigger` | 2.0 | **2.5** |
| `volume_ratio_min` | 1.5 | **2.0** |

Lowering trigger sensitivity requires code change in `resolveTriggerParams.ts` / `MarketDataService` unless wired to active strategy params.

---

## Recommendations

### Tier A — Config + DB only (no code; restart engine) — **DONE (M25 P1 + partial P3)**

**1. Switch active strategy to v2 momentum**

```env
ACTIVE_STRATEGY_VERSION_ID=3   # strategy_versions_id 3 = version 2 momentum
```

Shadow evidence: 583 open intents vs 0 live gate approvals on v1.

**2. Loosen strategy params** (update JSONB on active version, then restart)

```sql
UPDATE strategy_versions
SET params = params || '{
  "idiosyncrasy_min_score": 0.85,
  "stress_same_bar_trigger_count": 15,
  "max_trades_per_bar_universe": 5,
  "max_trades_per_symbol_per_day": 5,
  "require_oi_available": false,
  "oi_rising_skip": false
}'::jsonb
WHERE strategy_versions_id = 3;
```

| Param | Default | Paper exploration | Effect |
|-------|---------|-------------------|--------|
| `idiosyncrasy_min_score` | 0.5 | 0.85 | Fewer `idiosyncratic_trap` skips (MR only) |
| `stress_same_bar_trigger_count` | 5 | 15 | Fewer day-killing `market_stress` halts |
| `max_trades_per_bar_universe` | 1 | 5 | >1 open per 5m bar across universe |
| `oi_rising_skip` | true | false | Gate won't block fades on rising OI |
| `require_oi_available` | true | false | Gate won't reject missing OI |

**3. Env tweaks**

```env
MAX_OPEN_POSITIONS=3
MARKET_STRESS_AUTO_RESUME_ENABLED=true   # already set
```

**4. Ensure not halted**

Use dashboard Resume; confirm `risk_state.is_halted=false` for current UTC day.

**Expected impact:** More strategy opens (especially with v2). First live gate approvals on non-halted days. Paper fills via `PaperFillSimulator` (uses streaming adapter — different from shadow path).

**Do not expect:** Instant trades on halted days; v3 is wrong choice for volume (skips catalyst).

---

### Tier B — Small code changes (paper exploration) — **DONE (M25 P2)**

| Change | Location | Effect |
|--------|----------|--------|
| Wire `require_exhaustion_confirmation` param | `meanReversionCore.ts` | Toggle first-bar MR entries |
| Wire trigger params from active strategy version | `resolveTriggerParams.ts` | Lower σ / volume without const edit |
| `PAPER_RELAX_MARKET_STRESS=true` env | `StressHaltEvaluator.ts` | Soften/skip global halts in paper only |
| Paper bypass `regime_suppressed` | strategy cores | Trade through regime filter in paper |
| ATR stop fallback when structural clamp fails | `RiskGateService` | Fix `sl_outside_liquidation` (33 live rejects) |

---

### Tier C — Fix shadow fills (counterfactual PnL) — **PLANNED (M26)**

**Minimal fix:** pass trigger bar **high/low** from `IVolatilityDetectedEvent` into `simulateShadowFill` instead of `barHigh = barLow = entryPrice`.

**Better fix:** feed `tick_aggregates` / aggTrade for the signal bar (same as M7 backtest).

After fix:

1. Non-missed `simulated_fill` rows with real entry prices
2. Virtual ledger `tryOpen` / `tryClose` runs
3. Shadow PnL series for v2 vs v3 comparison (still `lowFidelity` until depth-aware fills)
4. M11b comparison becomes possible (under ADR 0019 lowFidelity rules)

**Scope:** `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` (+ tests).

---

### Tier D — Avoid for now — **N/A (guidance still valid)**

- Disabling live risk gate entirely — breaks live/backtest contract
- Further depth-floor cuts without 14-day slippage telemetry (M22 ADR condition)
- v0 baseline (`ACTIVE_STRATEGY_VERSION_ID=1`) — hard no-trade
- Shadow-only as substitute for live paper positions — shadow ledger empty today

---

## Comparison matrix

| Path | Strategy opens (14d) | Gate / fill | DB positions |
|------|---------------------|-------------|--------------|
| Live v1 | 350 gate attempts | 0 approvals | 0 |
| Shadow v2 | 583 | 100% missed fills | 0 |
| Shadow v3 | 216 | 100% missed fills | 0 |
| Live v2 (proposed) | TBD (expect >> v1) | Real `RiskGateService` + `PaperFillSimulator` | TBD |

---

## Key source files

| Layer | Path |
|-------|------|
| Trigger | `apps/engine/src/market-data/trigger/evaluateTrigger.ts` |
| Trigger params (live) | `apps/engine/src/market-data/const/triggerConsts.ts` |
| v1 MR core | `apps/engine/src/strategy/strategies/meanReversionCore.ts` |
| v2 momentum core | `apps/engine/src/strategy/strategies/momentumCore.ts` |
| v3 router | `apps/engine/src/strategy/strategies/V3HybridRouterStrategy.ts` |
| Flow classify | `packages/shared/src/util/classifyFlowType.ts` |
| Live orchestrator | `apps/engine/src/strategy/service/StrategyService.ts` |
| Shadow orchestrator | `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` |
| Virtual ledger | `apps/engine/src/strategy/service/VirtualPositionLedgerService.ts` |
| Live risk gate | `apps/engine/src/risk/service/RiskGateService.ts` |
| Stress halt | `apps/engine/src/risk/service/StressHaltEvaluator.ts` |
| Paper fills | `apps/engine/src/paper-mode/service/PaperFillSimulator.ts` |
| Missed-fill rule | `packages/shared/src/util/missedFillDetector.ts` |
| Shadow gate consts | `apps/engine/src/strategy/const/strategyConsts.ts` |

---

## Related docs / ADRs

- `docs/plans/00-overview.md` — skip-first design; no daily profit target
- `docs/plans/M11a-local-soak.md` — restricted v1 profile, shadow dry-run, soak exit criteria
- `docs/architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md` — shadow ledger + fill hard rule
- `docs/architecture/adr/0004-risk-management.md` — halt legs, depth guard, M23 auto-resume
- `docs/milestone-log.md` — M19 (0 trades / global halt), M21–M23 stress calibration
- `docs/work-log.md` — June 3 breadth halt investigation

---

## Suggested next actions (priority order)

1. **Activate v2** (`ACTIVE_STRATEGY_VERSION_ID=3`) + param SQL from Tier A → restart engine → watch for first gate approval with reason `momentum_follow`.
2. **Fix shadow bar high/low fill** → unlock counterfactual PnL on existing 3,333+ rows only for *future* events (historical rows stay missed unless backfilled/replayed).
3. **Optional:** paper-only stress relaxation env flag (Tier B) if v2 still blocked by `global_halt` on calm tape.
4. **Do not** use shadow PnL for promotion decisions until Tier C lands.

---

## Open questions

1. Should paper exploration use v2 only, or run v2 live + keep v1 as active for conservative baseline?
2. Replay/backfill shadow fills for historical `shadow_decisions` after Tier C fix, or forward-only?
3. Should shadow virtual gate be aligned closer to live `RiskGateService` for fairer counterfactual, or stay minimal by design?
4. Wire `require_exhaustion_confirmation` before or after v2 switch (v2 doesn't use exhaustion path)?

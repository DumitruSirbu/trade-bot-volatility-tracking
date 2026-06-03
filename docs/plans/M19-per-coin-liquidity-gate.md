# M19 — Per-coin liquidity gate (stop the global liquidity halt)

> **Revision note (post independent review):** Updated after three independent reviews
> (`docs/independent-analysis/{gbt,gemini,composer}/M19-*`). The biggest change: the breadth
> fix is now a **risk-only engine constant** instead of a `strategy_versions.params` migration,
> because `stress_breadth_pct` is **also** consumed by `classifyFlowType()` with different
> semantics — re-seeding it 70→30 would have silently changed `MARKET_BETA` flow routing
> (a strategy-signal change, out of scope). Decoupling makes **all of M19 code-only**: no
> migration, no soak-DB write. See "Independent-review amendments" at the bottom.

## Context

Three days of paper-soak data showed **0 trades from 97 open signals**. Root cause traced in
the live DB: the active strategy (v1) generated 97 valid open intents, but **all 97 were
blocked by the risk gate** — 83 `global_halt`, 8 `market_stress`, the remainder minor per-coin
rejects. The market was calm at every halt (BTC ±0.03%, tight spreads, OI/funding far below
thresholds). The **only** stress trigger that actually fired was `isLiquidityShock`'s
**book-depth-collapse** check: `book_depth_10bps_usdt ≤ $20,000`.

The universe is mostly thin tier-2 alts whose 10bps depth is $1k–$7k (median across the 97
opens: $26,812; min $1,024). The $20k floor fails roughly half of them. The architectural
defect: **a per-coin liquidity property is wired into a global, day-killing halt.** The first
thin alt to trigger on a UTC day flips `risk_state.is_halted=true`, and every subsequent
signal that day — even on deep-book majors like SOL/BNB/LINK/TON (all tier-1) — is rejected as
`global_halt`. It tripped on all 3 soak days, so the soak accumulates **no executable trades
and no calibration data**.

Secondary defect: the breadth-collapse halt is **permanently dead** — it tests
`|breadth − 50| ≥ stress_breadth_pct` with `stress_breadth_pct = 70`, but breadth is 0–100 so
the maximum possible distance is 50. It can never fire.

**Outcome wanted:** a thin coin gets skipped per-coin (not a market-wide halt), liquid coins
flow through to the rest of the gate, and the soak starts producing real trades. Also
resurrect the breadth halt with a working threshold so genuine breadth shocks still protect us,
**without** disturbing flow classification.

**Locked decisions:** per-tier depth floors `{ tier1: 20_000, tier2: 10_000, tier3: 5_000 }`;
breadth halt threshold `30` (distance from neutral 50 → fires at breadth ≤ 20 or ≥ 80),
implemented as a **risk-only const**, not a param migration.

## Scope

1. **Move depth-collapse out of the global stress halt → per-coin tier-keyed eligibility skip.**
2. **Fix the dead breadth halt** with a new risk-only const `STRESS_BREADTH_DISTANCE_PCT = 30`;
   `isBreadthCollapse` reads the const. `stress_breadth_pct` (param, =70) is left untouched and
   continues to drive `classifyFlowType()` exactly as today.
3. Keep spread-widening (`STRESS_SPREAD_PCT = 0.6`) as the remaining global liquidity-shock
   signal — a market-wide spread blowout still halts.

Out of scope: re-tuning OI/funding/BTC/ETH stress thresholds; any change to `classifyFlowType`
/ `MARKET_BETA` routing; strategy-signal changes; running the backtest harness (the harness
still has no isolation mode).

## Change set

### A. Shared contract — `packages/shared/`  (`bot-shared-maintainer`)
- `src/enum/RejectReasonEnum.ts`: add `COIN_BOOK_TOO_THIN = 'coin_book_too_thin'`.
- **No** snapshot/params type change. `book_depth_10bps_usdt` already exists on
  `marketSnapshotSchema.ts`; `stress_breadth_pct` stays in `strategyParamsSchema.ts` unchanged
  (still used by `classifyFlowType`).

### B. Engine — `apps/engine/`  (`bot-engine-nestjs`)
- `src/risk/const/riskConsts.ts`:
  - Add `COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number>` using **computed enum
    keys** (match the existing `TIER_SPREAD_CEILING_PCT` style at ~line 67):
    ```ts
    export const COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
        [CoinTierEnum.TIER_1]: 20_000,
        [CoinTierEnum.TIER_2]: 10_000,
        [CoinTierEnum.TIER_3]: 5_000,
    };
    ```
  - Add `STRESS_BREADTH_DISTANCE_PCT = 30` (risk-only; the breadth-halt distance from
    `MARKET_BREADTH_NEUTRAL_PCT`). Document that it is intentionally distinct from the
    `stress_breadth_pct` param used by `classifyFlowType`.
  - Remove `STRESS_BOOK_DEPTH_FLOOR_USDT` (now dead — only referenced by the evaluator/const
    /spec per grep 2026-06-03).
- `src/risk/service/StressHaltEvaluator.ts`:
  - `isLiquidityShock()`: remove the `depthCollapse` term and `STRESS_BOOK_DEPTH_FLOOR` usage;
    keep `spreadWidening`. Drop the now-unused import + module const. Leave
    `hasInvalidStressInputs` unchanged (depth was never in it; spread NaN fail-closed stays).
  - `isBreadthCollapse()`: read `STRESS_BREADTH_DISTANCE_PCT` instead of
    `params.stress_breadth_pct`. (Signature may drop the now-unused `params` arg if nothing
    else needs it.)
- `src/risk/service/RiskGateService.ts`:
  - Add private `isBookTooThin(intent, context): boolean`, **fail-closed** (mirror
    `isSpreadTooWide`'s `Number.isFinite` defense): treat missing / empty / unparseable /
    non-positive depth, or an unknown `intent.coinTier`, as too-thin → reject. Never throw out
    of the gate, never pass-open on bad input. For valid input:
    `new Money(depth).lessThanOrEqualTo(new Money(COIN_DEPTH_FLOOR_10BPS_USDT[tier]))`.
  - Insert into `firstFailingTierFilter()` (per-coin group, ~line 538) returning
    `RejectReasonEnum.COIN_BOOK_TOO_THIN`, **adjacent to the spread check**. Runs after the
    halt checks, so it can only skip the coin — never persist a halt.
  - **Boundary rule (explicit):** depth **at** the floor is rejected (`<=`); this matches the
    old global behavior. (Spread keeps its strict `>` ceiling: spread at the ceiling passes.)
- **No migration.** Breadth is a const; depth is a const. M19 writes nothing to the DB.

### C. Dashboard — `apps/dashboard/`  (`bot-dashboard-react`)
- `src/views/DecisionsFeed.tsx`: add a tooltip entry for `coin_book_too_thin` under the
  risk-gate reject-reason list so soak operators see context (avoids misreading the funnel
  during verification). Small, parallel with the engine wave.

### D. Tests  (`bot-qa-engineer`)
- `tests/risk/service/StressHaltEvaluator.spec.ts`:
  - Remove the depth-collapse global-stress cases (~lines 191–203); keep spread-widening.
  - Breadth halt at the new const **30**: fires at breadth **20** and **80**
    (`|20−50| = |80−50| = 30`); silent at **25** and **75** (distance 25 < 30). Update the
    `calmSnapshot`/`calmParams` comments that reference the old `80`.
- `tests/risk/service/RiskGateService.spec.ts`:
  - New `describe('coin book depth — per-tier floor')` mirroring the spread-filter suite
    (~lines 276–363): tier-1 deep passes; tier-1/2/3 thin → `COIN_BOOK_TOO_THIN`; **boundary**
    (tier-2 exactly 10_000 → reject; just above → pass depth gate).
  - **Adversarial (fail-closed):** malformed / missing / negative depth and unknown tier →
    `COIN_BOOK_TOO_THIN`, and assert `upsertDay` is **not** called with a halt (no
    `is_halted`), no thrown exception.
  - **Day-contagion regression (the core proof):** evaluate a thin tier-2/3 signal →
    `COIN_BOOK_TOO_THIN`; then, reusing the **same** UTC-day risk-state fixture, evaluate a
    deep tier-1 signal → it reaches approval / the next legitimate gate, **not** `GLOBAL_HALT`.
- `packages/shared` / strategy tests: add a `classifyFlowType` guard asserting MARKET_BETA
  routing is **unchanged** (param still 70) — proves the breadth decoupling didn't leak into
  flow classification.
- `tests/risk/support/fixtures.ts`: keep `buildPassingContext()` depth deep (`20000000.00`)
  so unrelated tests don't trip the new gate.
- **QA note:** backtest inline fixtures (`BacktestOrchestrator/RunnerService/ComparisonRunner`
  specs) hardcode `stress_breadth_pct: 70`. Because breadth now reads a const, the breadth halt
  becomes live in backtests too — confirm those fixtures still pass (calm breadth ~50 stays
  well under distance 30) and flag to the quant reviewer.

### E. Docs  (architect first, scribe last)
- **`bot-architect`**: revise **ADR 0004 §6** — (a) `book_depth_10bps_usdt` becomes a per-coin
  eligibility guard via per-tier `COIN_DEPTH_FLOOR_10BPS_USDT`, removed from the global
  stress-input list; (b) the breadth **halt** uses risk-only `STRESS_BREADTH_DISTANCE_PCT`
  (distance from neutral), explicitly distinct from the `stress_breadth_pct` param that
  `classifyFlowType` (ADR 0003) keeps using; (c) spread widening remains the global liquidity
  proxy. Locked-decision touch → architect runs **before** engine code.
- **`bot-scribe`**: `docs/plans/00-overview.md` RiskModule note, `docs/milestone-log.md`,
  `docs/work-log.md`, CLAUDE.md status line, and confirm the `DecisionsFeed` reject-reason
  reference is documented.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle)
1. **Serial — `bot-architect`**: ADR 0004 §6 revision (depth per-coin; breadth distance const
   vs flow param split). Resolves review H1/M3/L1 before any code lands.
2. **Serial — `bot-shared-maintainer`**: `RejectReasonEnum.COIN_BOOK_TOO_THIN`.
3. **Parallel — `bot-engine-nestjs` + `bot-dashboard-react`**: engine consts/evaluator/gate;
   dashboard tooltip.
4. **Serial — `bot-qa-engineer`**: paired tests per fix item (depth per-tier, fail-closed,
   day-contagion, breadth-at-30, classifyFlowType-unchanged guard).
5. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code`
   + `bot-review-quant`. Cycle fix→re-review until zero blockers, zero highs, majority mediums.
6. **Serial — `bot-scribe`**: docs + work-log.

Orchestrator verifies the actual diff after every wave.

## DB safety (HARD — CLAUDE.md invariants #8/#9)
M19 is **code-only** — no schema change, no `strategy_versions` write, no migration. The only
DB touch is the **post-deploy operator halt-clear** below, which is a single-row, scoped action
on `risk_state` for today's date. Before running it: take a `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip >
backup_$(date +%Y%m%d_%H%M).sql.gz`), show the user the path, and get **explicit confirmation**
in the same turn. No `-v`, no down/revert on the live soak.

## Post-deploy rollout (resolves review H2/M1 — stale halt contagion)
The depth fix stops **new** depth-driven halts, but any `risk_state` row already flipped to
`is_halted=true` earlier in the current UTC day persists until rollover. Without clearing it,
verification will falsely look broken (deep coins still `global_halt`).
1. After the new build is healthy, read today's `risk_state` row.
2. If `is_halted=true` with `halt_reason='market_stress'` **and** current market metrics are
   calm (the pre-M19 false-depth halt), use the existing operator path
   (`HaltService` → `RiskStateRepository.clearHaltForDate`) to clear **only** today's halt,
   after the dump + confirmation above. Otherwise wait for UTC rollover.
3. Distinguish "stale persisted halt" from "new gate behavior" in the writeup.

## Verification
- **Unit**: `rtk jest` for `risk/service/StressHaltEvaluator` + `risk/service/RiskGateService`
  green; full `src/risk` suite + the `classifyFlowType` guard green.
- **Behavioural (read-only on soak DB, after the stale-halt clear above):**
  - Re-run the decision-funnel query — thin-coin rejects now read `coin_book_too_thin`
    (per-coin skip); `global_halt` count falls sharply.
  - A deep-book tier-1 signal (SOL/BNB/LINK/TON) reaches later gates / opens.
  - `risk_state.is_halted` is no longer flipped by a single thin alt.
  - Snapshot with depth $5k + calm spread/BTC on a tier-2 intent → `coin_book_too_thin`, **not**
    `market_stress`; `is_halted` unchanged.
  - Breadth halt can fire: a decision with `|breadth−50| ≥ 30` yields `market_stress`
    (rare live; covered by unit test).
  - **Flow-type sanity (guards H1):** sample ~20 post-deploy OPEN/SKIP decisions and confirm
    the `MARKET_BETA` share did **not** shift (param untouched).
- **Milestone close**: 10-min live app smoke run; fix-and-report any boot/DI error before scribe.

## Success criteria
- A thin coin is skipped per-coin (`coin_book_too_thin`); the market is not halted.
- Deep-book coins flow to the rest of the gate; the soak starts logging executable trades.
- The breadth halt is live (const 30) and can fire; flow classification is unchanged.
- Invalid depth fails closed (skip, no throw, no halt).
- Zero blockers / zero highs / majority mediums resolved at close.

## Independent-review amendments (what was adopted)
Sourced from `docs/independent-analysis/{gbt,gemini,composer}/M19-*`.

| # | Finding (reviewer) | Resolution |
|---|--------------------|------------|
| H1 | `stress_breadth_pct` also drives `classifyFlowType` MARKET_BETA routing — re-seeding 70→30 is an out-of-scope strategy change (gbt, composer) | **Decouple:** breadth halt uses new risk-only const `STRESS_BREADTH_DISTANCE_PCT=30`; param stays 70 for flow routing. **Eliminates the migration entirely.** |
| H2/H4 | New depth gate must fail-closed on invalid/missing/negative depth + unknown tier (gbt, composer) | `isBookTooThin` fail-closed, mirrors `isSpreadTooWide`; adversarial tests added. |
| H2/M1 | Stale `is_halted` from the old bug survives deploy and blocks deep coins (gbt, composer) | Added post-deploy halt-clear rollout via existing `clearHaltForDate`, gated by dump + confirmation. |
| H3/M2 | Migration too broad / unsafe `down()` (gbt, composer) | **Moot** — no migration anymore (breadth is a const). |
| gemini-1 | Use computed enum keys in the Record | Adopted in the const sketch. |
| gemini-2 | `jsonb_set` `::jsonb` cast | **Moot** — no migration. |
| M1/M2/M3 | Day-contagion regression + explicit boundary semantics (`<=` floor) (gbt, composer) | Added two-signal same-day test + boundary tests + plan wording. |
| M3/L1 | ADR 0004 wording split (depth vs spread vs breadth) (gbt, composer) | Folded into the architect wave instructions. |
| M4 | Dashboard tooltip for `coin_book_too_thin` (composer) | Added `bot-dashboard-react` wave + scribe note. |
| M5/M6 | Test fixture breadth values; backtest fixtures (composer) | Added QA notes (breadth tests at 30; verify backtest fixtures under const). |

Net effect of the review: **M19 is now entirely code-only** (no soak migration), the breadth
fix no longer perturbs flow routing, and the riskiest deploy gap (stale halt) is covered.

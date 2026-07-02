# ADR 0048 — Rebalance orchestrator (`RebalanceSchedulerService` + `MomentumOrchestratorService`)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Milestone:** M50 (D3/D4)
- **Composes with:** ADR 0047 (the pure `IPortfolioStrategy` core this orchestrator drives),
  ADR 0004 (risk gate / `PositionSizer` / slots — **unchanged**), ADR 0005/0006/0007/0008
  (execution + idempotency + partial fills + SL/TP — **unchanged**), ADR 0009/0010
  (position state machine + reconciliation per `(symbol, side)` — **unchanged**), ADR 0029
  (shadow), ADR 0042 (paper gate), ADR 0032 (paper mode).
- **Amended by:** [ADR 0050](0050-xmom-cascade-topn-rebalance-anchor.md) §2.2 / §2.4 / §5 (M50b) —
  fixed 01:07 UTC cron; cascade close ordering keyed on `retained`; core returns full `ranked` list.

> **ADR numbering note.** The next free number after `0047` is **0048**; this ADR uses it.

---

## 1. Context

ADR 0047 defines a pure ranking core (`selectUniverse`) but deliberately leaves out
everything impure: *when* to re-rank, *where* the universe snapshot comes from, and *how* a
selection becomes positions. Cross-sectional momentum re-ranks on a **24h cadence**
(EXP-011/012) — a wall-clock trigger that must live **outside** the deterministic core so the
core stays reproducible (ADR 0047 §2.1, the ADR 0003 determinism rule).

This ADR defines the **outer loop**: a deterministic-clock scheduler that fires a rebalance
event on the param cadence, and an orchestrator that, on that event, ranks the universe and
turns the selection into positions **through the existing, unchanged risk gate and execution
path**. The split mirrors the VWAP path's own separation — `MarketDataService` detects, the
pure `IStrategy` decides, `StrategyService` (impure) gates and persists — applied to the
portfolio shape.

---

## 2. Decision

### 2.1 `UNIVERSE_REBALANCE_DUE_EVENT` — the trigger seam

A single `@nestjs/event-emitter` event decouples *time* from *ranking*:

```
const UNIVERSE_REBALANCE_DUE_EVENT = 'universe.rebalance.due';

interface IUniverseRebalanceDueEvent {
  nowMs: number;   // the rebalance instant; passed straight into selectUniverse + the gate
}
```

The payload is intentionally minimal: just `nowMs`. The event carries no ranking, no
universe, no side effects — emitting it is the scheduler's *only* job. This is the seam that
keeps the ranking core (ADR 0047) free of any clock dependency: `nowMs` originates here and
flows in as data.

### 2.2 `RebalanceSchedulerService` — interval emitter, deterministic clock

> **ADR 0050 amendment (M50b).** Cadence is a fixed daily cron at **01:07 UTC** (`7 1 * * *`),
> not `rebalance_interval_ms` from params. `rebalance_interval_ms` remains for time-stop sizing
> only (must equal 24h; WARN on mismatch). Fast tests use the event seam, not a shortened interval.

A NestJS service whose sole responsibility is to **emit `UNIVERSE_REBALANCE_DUE_EVENT` on the
`rebalance_interval_ms` cadence**. It does **no ranking**.

- **Cadence:** driven by `@nestjs/schedule` (`@Interval` / `@Cron`, per CommonModule's
  existing scheduler) configured from the active momentum version's `rebalance_interval_ms`.
  This keeps the cadence declarative and side-effect-free — the scheduler ticks, the service
  reads the clock once, emits, returns.
- **Deterministic clock injection.** The service does **not** call `Date.now()` directly. It
  reads the instant from an injected `ClockPort` (`{ nowMs(): number }`) that wraps
  `Date.now()` in production and is a controllable fake in tests. This makes rebalance timing
  fully testable and keeps the "no wall-clock outside an injectable seam" discipline — the
  emitted `nowMs` is then the authoritative instant for the whole rebalance.
- **Paper gate (ADR 0047 §2.6).** Registered/emits only when `EXCHANGE_ENV = paper` **and**
  `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` is set. Any other env ⇒ WARN + do not emit.

```
interface ClockPort { nowMs(): number; }   // wraps Date.now(); faked in tests
```

### 2.3 `MomentumOrchestratorService` — ranks, then routes through the UNCHANGED gate

Listens for `UNIVERSE_REBALANCE_DUE_EVENT`. On each event it:

1. Builds the universe snapshot (`UniverseEntry[]`, §5) for `event.nowMs`.
2. Calls the active portfolio strategy's `selectUniverse({ universe, params, nowMs })`
   (ADR 0047) — the pure core.
3. Reconciles the selection against currently-open momentum positions (§6) into a set of
   **close** and **open** intents.
4. Routes **every** intent through the **existing** path: `RiskGateService.evaluate(intent,
   context)` → on approval `PositionSizer` sizes it → the standard execution flow places it —
   the identical sequence `StrategyService.gateAndPersist` uses for VWAP.

**Hard invariants:**
- It **does not bypass the risk gate.** No order is constructed or submitted except as the
  gate's approved output. A momentum open can be gate-rejected (`max_positions_reached`,
  stress halt, depth/cooldown) exactly like a VWAP open — and that is the expected,
  logged behavior under the shared slot pool (ADR 0047 §2.4). *Exception:* the gate's
  **per-snapshot** stress-halt check does not fire for momentum opens in M50 because the
  snapshot's global-stress fields are synthesized neutral — see §3.1. A **durable** stress
  halt in `risk_state` still blocks momentum opens.
- It **does not call the exchange order API directly.** Execution stays the sole order
  caller (ADR 0005 boundary).
- It records a `decisions` row per evaluated leg (open/close/skip + reason), reusing the
  existing decision-persistence pattern, stamped with the momentum `strategy_version_id`.
- Risk-reducing **close** intents pass under a halt (ADR 0046); **open** intents do not.

### 2.4 Ordering within a rebalance — closes before opens

> **ADR 0050 amendment (M50b).** Three-tier ordering: (1) definite de-rank closes — symbol absent
> from `ranked`; (2) cascade walk — hold/open until `top_n` gate-approved fills; (3) residual
> de-rank closes — in `ranked` but not in post-walk `retained`. See ADR 0050 §2.2.

Within one rebalance the orchestrator emits **closes first, then opens**, so a freed slot
from a de-ranked symbol is available to a newly-selected one in the same cycle. This ordering
is deterministic (closes sorted by symbol, opens in rank order) for reproducibility.

### 2.5 Concurrency / overlap guard

A rebalance must not overlap itself (a long fill path must not collide with the next tick).
The orchestrator guards with a single in-flight flag: if a rebalance is still running when the
next `UNIVERSE_REBALANCE_DUE_EVENT` arrives, the new one is **skipped with a logged
`rebalance_overlap_skipped`** rather than queued. At a 24h cadence this is purely defensive.

---

## 3. The risk-gate / execution path is reused verbatim

The orchestrator constructs the engine-internal `IOrderIntent` (risk/interface) for each leg
— `intentAction = open` for a new selection, `reduce`/`close` for a de-ranked exit — and
hands it to `RiskGateService.evaluate`. Sizing (`PositionSizer`), slot assignment, exposure
caps, stress halt, cooldowns, SL/TP attach, idempotency, and partial-fill handling are **all
the existing components, unmodified**. M50 adds **no** new risk rule and **no** new execution
code path; it adds a new *producer* of intents that feeds the same gate.

`signalScore` for a momentum leg is a deterministic function of rank (e.g. monotonic in
`trailingReturnPct`/rank) so the gate's tie-break and conviction logic remain well-defined;
`flowType`/`correlationMode`/`coinTier` are taken from the universe entry. These are intent
*metadata*, not new gate inputs.

### 3.1 Known limitation — synthesized snapshot bypasses the per-snapshot stress-halt check (M50)

> **CAVEAT (M50 scope limitation).** The parity claim above holds for **sizing, slots,
> exposure caps, cooldowns, SL/TP, idempotency, and partial fills** — but **not** for the
> gate's *per-snapshot* stress-halt check. `buildMomentumSnapshot` in
> `MomentumOrchestratorService` currently **hardcodes all global-stress fields to neutral
> values**: `btc_5m_move_pct = 0`, `btc_1m_move_pct = 0`, `eth_5m_move_pct = 0`,
> `market_breadth_5m_up_pct = 50` (neutral), `same_bar_trigger_count = 0`, and
> `open_interest_change_5m_pct = 0`.
>
> **Consequence.** Because those fields feed the gate's per-snapshot stress evaluation, that
> check **does not fire for momentum opens** — not even during a live BTC/ETH correlated
> shock or a market-wide breadth collapse. A momentum open evaluated off a synthesized
> neutral snapshot sees "calm" conditions regardless of the real market. This is a **real
> divergence** from the VWAP path, which populates these fields from live market data.
>
> **Mitigation (why this is bounded, not open-ended).** The check that is bypassed is only
> the *per-snapshot* one. Any **durable** halt — one written to the `risk_state` table by a
> prior VWAP evaluation (or any other prior evaluation) — **still blocks momentum opens**,
> because the orchestrator passes the **unchanged `RiskStatePortAdapter`** to the gate and the
> gate reads the persisted halt before approving any open. So once *any* path has tripped a
> durable stress halt, momentum opens are correctly blocked; what is missing is momentum's
> ability to *originate* a fresh per-snapshot stress detection from its own (neutral) inputs.
>
> **M50b follow-up (blocker for non-paper promotion).** Before this orchestrator is promoted
> beyond `EXCHANGE_ENV = paper`, wire a live global-breadth / correlated-shock source (a
> `MarketContextService` or equivalent — out of M50 scope) so `buildMomentumSnapshot` carries
> real BTC/ETH move, breadth, same-bar-trigger, and OI-change values, restoring full
> per-snapshot stress-halt parity. Tracked as an M50b item; this caveat must not survive into
> a live path.

---

## 4. Determinism boundary (where impurity is allowed)

| Concern | Where it lives | Pure? |
|---------|----------------|-------|
| Re-rank cadence / clock | `RebalanceSchedulerService` + `ClockPort` | No (injected clock) |
| Universe snapshot read | `MomentumOrchestratorService` (§5) | No (reads market-data state) |
| **Ranking** | `crossSectionalMomentumCore` (ADR 0047) | **Yes** |
| Open-position reconciliation | `MomentumOrchestratorService` (§6) | No (reads `PositionService`) |
| Gate / sizing / execution | existing risk + execution modules | unchanged |

Only `crossSectionalMomentumCore` is pure. Everything that touches a clock, market-data
state, or the DB is in the orchestrator/scheduler — never in the core. `nowMs` is threaded
from the scheduler through the event into the core and the gate context, so the ranking
instant is single-sourced and reproducible.

---

## 5. Universe snapshot — how the orchestrator builds `UniverseEntry[]`

The orchestrator assembles the ranking input by joining **membership** with a **trailing
return** per symbol:

- **Membership / tier / volume:** `UniverseService.getEntries()` (existing) — the
  point-in-time top-N-by-volume set with `tier` and `quoteVolume24h`.
- **Trailing return:** the per-symbol move over `lookback_ms`. The market-data
  `SymbolMarketState.movePctOverWindow(lookbackMs, nowMs)` already computes exactly this and
  returns `null` when there is insufficient history — that `null` IS the missing-data signal.
  - **Coverage note (impl guard for D4):** `movePctOverWindow` reads the in-memory price
    tape, whose retention may be shorter than 24h on a cold start. If the tape does not cover
    `lookback_ms`, the snapshot builder must source the lookback close from the persisted 5m
    `candles` table (a read in the orchestrator, which is allowed to do I/O) so a fresh boot
    does not silently rank on a truncated window. Either way the per-symbol return is a single
    scalar handed to the pure core.

The resulting `UniverseEntry` carries at least `{ symbol, trailingReturnPct, tier }`.
Symbols with a `null`/`NaN`/`undefined` return are **excluded by the builder before** the
core sees them (belt) and **again guarded inside the core** (suspenders, §7 / ADR 0047 §2.1).

### `crossSectionalMomentumCore` — the pure ranking function (ADR 0047 §2.1)

```
crossSectionalMomentumCore(universe: UniverseEntry[], params: IMomentumParams, nowMs): IPortfolioSelection
```

Algorithm (pure, deterministic, no I/O):
1. **Eligibility filter:** drop entries whose `trailingReturnPct` is `null`/`NaN`/`undefined`
   (missing-data guard).
2. **Min-universe guard:** if the eligible count `< min_universe_size`, return
   `{ selected: [], reason: universe_too_small }` — do not rank a thin universe.
3. **Rank:** sort eligible entries by `trailingReturnPct` **descending**; break ties by
   `symbol` ascending (deterministic, matches the VWAP candidate tie-break, ADR 0004 §4).
4. **Select top-N:** take the first `top_n`, assign dense `rank` 1..N, return
   `{ selected, reason: ranked }` (or `no_eligible_symbols` if none survive step 1).

No clock read, no RNG, no mutation of `universe`. Same inputs ⇒ same selection, always.

---

## 6. Position lifecycle in M50 — hold / open / close on each rebalance

Each selected leg is a **separate position** opened via the existing `IOrderIntent` → gate
path. On each rebalance the orchestrator reads currently-open momentum positions (from
`PositionService` / the existing open-positions read it already exposes to the risk gate,
filtered to the momentum `strategy_version_id`) and diffs them against the new selection:

| State | Action |
|-------|--------|
| In top-N now **and** already open | **Hold** — no intent (no re-entry churn) |
| In top-N now **and** not open | **Open** — `intentAction = open` through the gate |
| Open **and** no longer in top-N | **Close** — `reduce`-to-zero / `close` intent (de-rank exit) |

The de-rank close is a risk-reducing intent: it is gate-auto-approved and passes under a halt
(ADR 0004 §2 / ADR 0046). Holding rather than re-entering a still-ranked symbol avoids
needless fees and slippage (survival-first). A close emitted here finalizes via the standard
position state machine and reconciliation — no special-casing.

## 7. No DB migration

Momentum positions use the **existing `positions` table** with `strategy_version_id` pointing
at the portfolio strategy version (an ordinary `strategy_versions` row, ADR 0047 §2.2).
Reconciliation already keys per `(symbol, side)` (ADR 0010), so multiple concurrent positions
across strategies need **no schema change**. Decisions reuse the existing `decisions` table.
**M50 ships zero migrations.**

---

## 8. Invariants this ADR defends

- **No order path bypasses the risk gate.** The orchestrator only produces intents; the
  unchanged gate is the sole approver and execution the sole order caller (§2.3, §3).
- **Determinism / parity.** Ranking is pure (§4); the clock is injected (§2.2); `nowMs` is
  single-sourced from the scheduler through the event. Same tape ⇒ same rebalance.
- **No LLM in the loop.** Scheduler + ranking math + gate routing; no model call.
- **Money is `decimal`.** The orchestrator passes scalars; all sizing/PnL stays `decimal.js`
  in the unchanged risk/execution path.
- **No live capital in M50.** Scheduler + orchestrator register only under
  `EXCHANGE_ENV = paper` (§2.2, ADR 0047 §2.6).
- **Closes survive halts.** De-rank exits route as risk-reducing intents (ADR 0046).

---

## 9. Consequences

- Time and ranking are cleanly separated: the cadence is a testable, injectable clock; the
  ranking is a pure function; the two meet only through a minimal `{ nowMs }` event.
- M50 reuses the entire risk/execution/reconciliation stack with zero modification and zero
  migration — it adds one event, one scheduler, one orchestrator, and one pure core.
- Under the shared slot pool, a momentum open can lose to VWAP and gate-reject; this is
  logged as a normal outcome (ADR 0047 §2.4), addressed by the M50b disjoint namespace.
- The 24h-coverage caveat (§5) is the one real implementation risk; D4 must source the
  lookback close from `candles` when the in-memory tape is short, or ranking on a cold boot
  is silently wrong.
- The synthesized-snapshot caveat (§3.1) means momentum opens do not self-originate a
  per-snapshot stress halt in M50; durable halts still protect them. This is acceptable only
  under `EXCHANGE_ENV = paper` and is an explicit M50b blocker for non-paper promotion.

---

## 10. Alternatives considered

- **Rank inside the scheduler (one service).** Rejected. Couples the clock to the ranking and
  makes the ranking impure/untestable in isolation — defeats the ADR 0047 determinism rule.
  The event seam keeps the core pure.
- **Cron the orchestrator directly with no event.** Rejected. The event seam lets a future
  trigger (manual rebalance endpoint, backtest replay driver) drive the same orchestrator
  without a scheduler, and keeps the "emit-only" service trivially testable.
- **Read `Date.now()` directly in the scheduler.** Rejected. Non-deterministic rebalance
  timing is untestable; `ClockPort` injection costs nothing and buys controllable time in
  tests — consistent with the project's no-wall-clock-in-logic discipline.
- **Flatten-and-reopen the whole book every rebalance.** Rejected. Churns fees/slippage on
  symbols that stayed ranked; holding survivors (§6) is survival-first and matches the
  EXP-012 hold semantics.
- **A bespoke momentum order path that skips the risk gate "because it's paper."** Rejected
  outright — violates the non-negotiable "no order path bypasses the risk gate" invariant and
  would diverge paper behavior from any future live path. The gate runs in paper too.
- **A new `momentum_positions` table.** Rejected. The existing `positions` +
  `strategy_version_id` + per-`(symbol,side)` reconciliation already supports multi-position;
  a new table is needless schema and migration risk.

---

## Amendment — M50c (2026-07-02): trigger-source persisted to `positions.trigger_source`

### Context

M50b added `RebalanceTriggerSourceEnum` (`scheduled` / `manual`) threaded from the
`IUniverseRebalanceDueEvent` through `MomentumOrchestratorService.rebalance` into the
intent builders, where it was used **only to suffix the decision `event_id` string**
(e.g. `xmom-open-BTCUSDT-1234-manual`). A quant review found this does not close the real
gap: the calibration and cross-version comparison surfaces
(`packages/analysis/src/query/getPerformance.ts`,
`packages/analysis/src/query/compareVersions.ts`) aggregate the **`positions`** table keyed
on `strategy_version_id`, and `PositionEntity` has no link back to `decisions.event_id` and
no trigger-source field. So a manually-triggered trade is indistinguishable from a scheduled
one in every performance metric — manual triggers (operator smoke tests, ad-hoc rebalances)
silently contaminate the paper-soak calibration sample. This amendment persists the
trigger-source onto the position row itself so the analysis surfaces can fence manual trades
out of the primary aggregation.

### Decision

**1. Column.** Add `positions.trigger_source` — nullable `varchar` carrying the
`RebalanceTriggerSourceEnum` string value (`scheduled` | `manual`). `NULL` is the correct and
permanent value for: all pre-existing rows (no backfill), and every VWAP / legacy single-symbol
open, which has no rebalance-trigger concept. The property on `PositionEntity` is
`triggerSource?: RebalanceTriggerSourceEnum | null`. Named `trigger_source` (not
`opened_via`) to match the `triggerSource` term already threaded through the event and
orchestrator, and the enum name. It is a provenance/attribution field, not a market-feature
snapshot, so it deliberately does **not** take the `_at_entry` suffix used by the frozen
entry-analysis columns.

**2. Propagation path (typed field on the intent — no shared-contract change).** The value
rides the same intent → position path the existing entry-time fields use
(`flowTypeAtEntry ← intent.flowType`, `coinTier ← intent.coinTier`,
`correlationMode ← intent.correlationMode`). Concretely:

- Add `readonly triggerSource?: RebalanceTriggerSourceEnum;` to the **engine-internal**
  `IOrderIntent` (`apps/engine/src/risk/interface/IOrderIntent.ts`). This is **not** a
  `packages/shared` change — that interface is engine-local, and `RebalanceTriggerSourceEnum`
  already lives in `@bot/shared`. Optional because the VWAP path (`StrategyService`) never
  sets it. **`bot-shared-maintainer` is not required.**
- `MomentumOrchestratorService.buildMomentumOpenIntent` (already receives `triggerSource`)
  sets `triggerSource` on the returned intent object. (The close intent may set it too for
  symmetry, but close intents create no position row, so it is not load-bearing there.)
- `IOrderIntentApprovedEvent` needs **no change** — it already carries the full `intent`, so
  the value reaches the executor as `event.intent.triggerSource` for free.
- `ExecutionService.createPositionFromFill` adds one line to the `positions.createOpen({…})`
  call: `triggerSource: event.intent.triggerSource ?? null`. `createOpen` already takes
  `DeepPartial<PositionEntity>`, so no repository DTO changes.

The **eventId-suffix-parsing alternative** (have the position-creation step re-parse the
`-manual` suffix back out of `intent.eventId`) is **rejected**: it is fragile string-parsing
(Law-of-Demeter / stringly-typed), breaks silently if the `event_id` format ever changes,
has no clean value for the suffix-less VWAP eventIds, and contradicts the established typed
intent-field precedent. The eventId suffix from M50b becomes redundant for analysis once the
column exists; it may remain as a human-readable log/debug aid.

**3. Migration.** One additive migration under `apps/engine/src/database/migrations/`,
matching the `AddPositionCorrelationMode` precedent exactly (TypeORM `MigrationInterface`,
`ClassNameNNNN` with the timestamp echoed into the `name` field). Timestamp must sort after
the current max (`20260709000100`); use `20260710000000-AddPositionTriggerSource.ts`. Nullable,
no backfill (`NULL` = unknown/pre-existing/VWAP — not a data-loss concern):

```
up():   ALTER TABLE "positions" ADD COLUMN "trigger_source" varchar
down(): ALTER TABLE "positions" DROP COLUMN IF EXISTS "trigger_source"
```

A full `pg_dump` (`backups/backup_20260702_1022.sql.gz`) was taken before this migration per
the DB-safety rule.

**4. Analysis surfaces — exclude manual from the primary aggregation.** Manual-triggered
positions are fenced out of calibration by default (this is what closes the HIGH finding).
Add `AND (p.trigger_source IS NULL OR p.trigger_source <> 'manual')` to:

- `PERFORMANCE_SQL` in `getPerformance.ts` (alongside the existing `p.state = 'closed'` /
  window predicates). `NULL` rows (VWAP + pre-existing) are retained — they are legitimate
  scheduled/organic history.
- the active-side CTE in `compareVersions.ts` (`buildActiveSideCte`), so paired-diff events
  anchored to a manual position are excluded symmetrically. The shadow-side CTE is unaffected
  (`shadow_decisions` has no manual triggers).

The value is bound as a positional parameter, not string-interpolated, to honour the
boundary-lint SQL-injection rule. Surfacing manual trades as a separate breakdown is deferred
— the calibration surfaces only need the exclusion; a manual-vs-scheduled report is a future
enhancement, not part of closing this finding.

### Consequences

- Manual smoke-test / ad-hoc rebalances no longer contaminate paper-soak calibration or A/B
  comparison metrics.
- Zero `packages/shared` churn; single engine-agent pass (entity + intent field + one
  executor line + one migration + two SQL predicates).
- `NULL` semantics stay honest: absence means "scheduled/organic/unknown", never "manual".

### Alternatives considered

- **Parse the trigger-source back out of `intent.eventId`.** Rejected — see §2.
- **New `positions.opened_via` name.** Rejected — `trigger_source` matches the enum and the
  already-threaded `triggerSource` term; consistency over novelty.
- **`NOT NULL DEFAULT 'scheduled'` with backfill.** Rejected. It would assert that every
  pre-existing and every VWAP row was "scheduled", which is false for the VWAP path (no such
  concept) and unverifiable for legacy rows. `NULL` = unknown is the truthful state.
- **Join `positions → decisions` on `event_id` at query time to recover the suffix.** Rejected.
  `PositionEntity` has no `event_id` FK; adding one plus a runtime join is far more surface than
  a single denormalised column, and re-introduces the fragile suffix parse.
</content>

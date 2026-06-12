# Independent Review — M27 Decision Data-Capture Completeness

**Plan reviewed:** `docs/plans/archive/M27-decision-data-capture-completeness.md`  
**Codebase snapshot:** 2026-06-08 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M27 correctly targets the **P5 observability gap** in the M24→M27 arc: once paper fills exist, the soak dataset still cannot support outcome-based tuning because live `decisions` rows lack trade geometry, halt-leg specificity, truthful concurrency context, exact L2 rejoin keys, and strict schema guards. The architect analysis §4 diagnosis is **code-verified**. Shadow rows already demonstrate the capture pattern (`gate_allowed`, `trade_side`, `qty`, `stop_loss`, `take_profit`); live `persistDecision` writes only symbol, snapshot, action, and reason.

The plan’s **observability-only** constraint is correct and load-bearing: geometry and halt metadata must be stamped **after** `riskGate.evaluate()` (mirroring `stampGateVerdict` for `position_slot`), not fed back into gate inputs. `active_positions_count` is not read anywhere in `apps/engine/src/risk/` today — only persisted in JSONB — so fixing it at stamp/persist time should not change gate outcomes if implemented post-evaluate.

**Assessment:** **Approve with amendments** — ship as shared-first + split engine dispatches with DB-safety waves. Correct the shared-contract scope (entity columns, not `marketSnapshotSchema` bloat). Lock halt-leg sourcing rules. Replace vague “mirror partitioning” for `book_snapshots` with a concrete sparse-write retention policy. Consider `mid_at_trigger` on the book row (ADR 0005 deferred since M2). Add a golden gate fingerprint test for the behaviour-unchanged guarantee.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A+ | Geometry/halt leg/dry-run count/no book writer/warn-only Zod all verified against entities and writers. |
| Sequencing & scope | A | Parallel with M26 OK; migrations correctly flagged; dashboard defer sensible. |
| Trade geometry design | A- | Shadow parity is the right template; notional/leverage cheap via `IIntentSizing`. |
| Shared contract plan | C+ | Listing `gate_allowed`/SL/TP in `marketSnapshotSchema` duplicates entity columns and breaks drift-guard semantics. |
| Halt-leg capture | B | On-row preferred; must distinguish `classifyHaltLeg` suffix vs full `risk_state.halt_reason`. |
| `active_positions_count` | A- | Source `openPositionsPort.findOpen().length` post-gate; remove `ACTIVE_POSITIONS_COUNT_DRY_RUN`. |
| `book_snapshots` writer | B- | `event_id` migration needed; retention wording wrong; `mid_at_trigger` still missing from schema. |
| Zod hard-fail | B+ | Key off `EXCHANGE_ENV=live` (not only `NODE_ENV`); inject config into repository. |
| Behaviour unchanged QA | B | Funnel mix is noisy; require deterministic gate fingerprint on fixed fixture set. |
| DB safety | A | Dump-before-each-migration, additive/nullable, M16 test DB — aligned with CLAUDE.md #8/#9. |
| Dispatch waves | A | ≤5-file splits and shared-first are appropriate for this milestone size. |

**Bottom line:** **Yes, add nullable geometry + halt-leg columns to `decisions` and populate from `IRiskDecision` at persist time.** **Yes, wire a live `book_snapshots` writer keyed by `event_id`.** **No, do not put trade geometry into `marketSnapshotSchema`.** **No, do not imply `book_snapshots` already has tick-style partitioning** — specify sparse-write retention explicitly. Amend architect wave to lock halt-leg + book-row column set (including `mid_at_trigger` follow-on).

---

## Verified Current State

### Live `decisions` has no trade geometry; shadow does

```14:51:apps/engine/src/strategy/entity/DecisionEntity.ts
export class DecisionEntity {
    // ...
    @Column({ name: 'market_snapshot', type: 'jsonb' })
    marketSnapshot!: IMarketSnapshot;

    @Column({ name: 'action', type: 'varchar' })
    action!: string;

    @Column({ name: 'reason', type: 'varchar', nullable: true })
    reason?: string | null;

    @Column({ name: 'position_id', type: 'integer', nullable: true })
    positionId?: number | null;
}
```

```51:74:apps/engine/src/strategy/entity/ShadowDecisionEntity.ts
    @Column({ name: 'trade_side', type: 'text', nullable: true })
    tradeSide?: string | null;

    @Column({ name: 'qty', type: 'text', nullable: true })
    qty?: string | null;

    @Column({ name: 'stop_loss', type: 'text', nullable: true })
    stopLoss?: string | null;

    @Column({ name: 'take_profit', type: 'text', nullable: true })
    takeProfit?: string | null;

    @Column({ name: 'gate_allowed', type: 'boolean' })
    gateAllowed!: boolean;
```

Shadow population pattern is explicit and gate-time faithful:

```400:427:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
        await this.shadowDecisions.insertShadowDecision({
            // ...
            rejectReason: gateOutcome.allowed ? null : (gateOutcome.rejectReason ?? null),
            gateAllowed: gateOutcome.allowed,
            qty: openData?.qty ?? null,
            stopLoss: openData?.stopLoss ?? null,
            takeProfit: openData?.takeProfit ?? null,
            marketSnapshot: snapshot,
        });
```

Live `persistDecision` does not receive `IRiskDecision` or sizing today:

```401:411:apps/engine/src/strategy/service/StrategyService.ts
    private async persistDecision(event: IVolatilityDetectedEvent, snapshot: IMarketSnapshot, signal: ISignal, action: string, reason: string): Promise<void> {
        await this.decisions.record({
            symbol: event.symbol,
            strategyVersionId: this.activeStrategyVersionId,
            ts: new Date(event.entryCandleOpenTime + CANDLE_INTERVAL_MS),
            eventId: event.eventId,
            signalType: signal.signalType,
            marketSnapshot: snapshot,
            action,
            reason,
        });
    }
```

Approved sizing and clamped exit are available on `IRiskDecision` (`IIntentSizing` carries `qty`, `notional`, `leverage`; `clampedExit` carries SL/TP) — cheap to mirror shadow’s open-only nullable pattern.

### Gate path already stamps `position_slot` post-evaluate; count is still dry-run zero

```290:301:apps/engine/src/strategy/service/StrategyService.ts
        const decision = await this.riskGate.evaluate(intent, context);
        const stampedSnapshot = this.stampGateVerdict(snapshot, decision);

        await this.recordGateDecision(event, stampedSnapshot, signal, intent, decision);
```

```341:347:apps/engine/src/strategy/service/StrategyService.ts
    private stampGateVerdict(snapshot: IMarketSnapshot, decision: IRiskDecision): IMarketSnapshot {
        if (decision.approvedSlot === null) {
            return snapshot;
        }

        return { ...snapshot, position_slot: decision.approvedSlot };
    }
```

```46:47:apps/engine/src/strategy/mapper/marketSnapshotMapper.ts
        position_slot: PositionSlotEnum.A,
        active_positions_count: ACTIVE_POSITIONS_COUNT_DRY_RUN,
```

`ACTIVE_POSITIONS_COUNT_DRY_RUN = 0` (`strategyConsts.ts` line 49). Comment still says “M4 supplies the real live count” — M27 is that follow-through. Extend `stampGateVerdict` (or a sibling `stampObservabilityFields`) to set `active_positions_count` from `(await context.openPositions.findOpen()).length` **after** evaluate, using the same `IOpenPositionsPort` the gate already consults in `buildGateContext`.

### Halt leg lives on `risk_state`, not on decisions

M23 writes suffixed reasons (`market_stress:breadth`, `market_stress:multi`, etc.) via `buildPersistedHaltReason`. Decision rows store only coarse enums in `reason` (`global_halt`, `market_stress`, …). `StressHaltEvaluator.classifyHaltLeg()` returns canonical suffix tokens (`breadth`, `btc_shock`, `multi`, …) for a stressed snapshot — usable at **reject** time for `market_stress`. For `global_halt`, the durable leg is on today’s `risk_state.halt_reason` (date-keyed), which is why the architect’s date-join fuzziness matters.

`packages/analysis` already exposes `selectHaltState` for day-level halt reads — a join helper is feasible but inferior to an on-row `halt_leg` / `halt_reason_detail` column populated at write time.

### `book_snapshots`: schema exists, no live writer, no `event_id`, no `mid_at_trigger`

```8:27:apps/engine/src/market-data/entity/BookSnapshotEntity.ts
@Entity({ name: 'book_snapshots', synchronize: false })
@Index('idx_book_snapshots_symbol_ts', ['symbol', 'ts'])
export class BookSnapshotEntity {
    // symbol, ts, spread, depth_10bps, depth_50bps only
}
```

`BookSnapshotRepository.record()` exists; `MarketDataPersistenceListener` does **not** subscribe to `volatility.detected` — only candles, ticks, OI, funding, universe transitions. Backtest loads book rows by `(symbol, barOpenMs)` window (`BacktestRunnerService.buildBookIndex`). ADR 0005 and `StrategyService` comments still expect `book_snapshots.mid_at_trigger` keyed on `event_id` — **that column was deferred at M5** and is still absent. M27’s `event_id` index enables exact rejoin; adding `mid_at_trigger` on write closes the forensic IOC reference gap.

Trigger-time microstructure is already on the wire (`IVolatilityDetectedEvent`: `bidAskSpreadPct`, `bookDepth10bpsUsdt`, `bookDepth50bpsUsdt`) — the writer can map these without a new exchange call.

### Zod validation is warn-only today

```62:77:apps/engine/src/strategy/repository/DecisionRepository.ts
    private validateMarketSnapshot(decision: Partial<DecisionEntity>): void {
        // ...
        const parsed = marketSnapshotSchema.safeParse(decision.marketSnapshot);

        if (!parsed.success) {
            this.logger.warn(`market_snapshot for ${decision.symbol ?? 'unknown'} failed validation (degraded): ${paths}`);
        }
    }
```

`marketSnapshotSchema` is `.strict()` with 40 strategy/risk context fields — it should **not** gain trade-geometry keys (see amendments).

### Read API / dashboard contract unchanged by default

`IDecisionView` (ADR 0022) exposes id, occurredAt, symbol, action, flowType, signalScore, reason, strategyVersionId, eventId, positionId — **no geometry**. Plan correctly defers dashboard; `packages/analysis` `getDecisions` projects the same slim shape. New columns are for SQL/MCP soak analysis unless a follow-on widens the read contract.

---

## Decision Critique — Pros and Cons

### 1. Entity-column parity with shadow (items 1–2)

| Pros | Cons |
|------|------|
| Single-row reconstruct of intended trade; joins shadow/live on `event_id`. | Migration + entity + writer churn; must keep nullable for skips/legacy rows. |
| Matches proven shadow cold-restart pattern (W5a). | `persistDecision` call sites multiply (gate, skip, pre-gate skip, correlated loser). |

**Verdict:** **Correct.** Mirror shadow column names/types (`text` decimals for qty/SL/TP, boolean `gate_allowed`). Add `notional` and `leverage` as nullable text decimals when `approvedSizing !== null`.

### 2. On-row halt leg vs date join helper

| Pros | Cons |
|------|------|
| Self-describing per decision; no ambiguous UTC-date join when multiple halts/re-resumes occur in a day. | Two sources: `classifyHaltLeg` for fresh `market_stress` rejects vs `risk_state.halt_reason` for `global_halt`. |
| Soak SQL becomes trivial (`WHERE halt_leg = 'breadth'`). | Must not write leg on non-halt rejects (NULL). |

**Verdict:** **Prefer on-row** as plan states. Store either the **full persisted string** (`market_stress:breadth`, `daily_loss_breach`) or a normalized pair (`halt_reason` + `halt_leg` suffix) — architect should pick one column, not both redundant strings.

### 3. Real `active_positions_count` in JSONB only

| Pros | Cons |
|------|------|
| Field already in `marketSnapshotSchema` and drift guards; no new analysis column needed for concurrency studies. | JSONB update changes persisted snapshot bytes — document that pre/post M27 rows differ on this field only. |

**Verdict:** **Correct scope.** Do not add a duplicate integer column on `decisions` unless analysis explicitly wants indexable concurrency without JSONB operators.

### 4. Live `book_snapshots` writer + `event_id`

| Pros | Cons |
|------|------|
| Exact `decisions.event_id` ↔ `book_snapshots.event_id` join replaces fuzzy `symbol`+`ts` window. | Second migration wave; writer placement must avoid order-path coupling. |
| Reuses event wire depth/spread fields. | Without `mid_at_trigger`, ADR 0005 forensic IOC story remains incomplete. |

**Verdict:** **Approve** with retention and column-set amendments below.

### 5. Zod hard-fail in non-prod

| Pros | Cons |
|------|------|
| Catches schema drift before soak corruption. | Throwing in paper soak on `EXCHANGE_ENV=paper` could drop decisions if deployed carelessly. |

**Verdict:** **Approve** if hard-fail is **`EXCHANGE_ENV !== 'live'`** (paper + testnet + test), warn-only on live — matches trading-safety posture better than `NODE_ENV` alone.

---

## Must-fix before dispatch

### H1 — Do not extend `marketSnapshotSchema` with trade geometry

The plan’s shared wave lists `gate_allowed`, side, SL/TP, qty/notional in `marketSnapshotSchema`. That schema is the **40-field strategy/risk context** contract (`marketSnapshot.driftGuard.spec.ts` explicitly separates `DECISION_CONTEXT_FIELDS` from event wire fields). Trade geometry belongs on **`DecisionEntity` columns** (and optionally a future `IDecisionCaptureRow` in shared for analysis exports), not inside JSONB.

Shared maintainer wave should cover:

- Nullable types / enums only if promoted (e.g. shared halt-leg string union for analysis).
- **No** change to `marketSnapshotSchema` except if a new observability field is genuinely part of the snapshot (none of the five items require it beyond fixing `active_positions_count` at stamp time).

### H2 — Population must flow through `recordGateDecision` / `persistDecision` signature change

Thread `IRiskDecision`, and for approved opens `IApprovedRiskDecision` narrowing, into `persistDecision`:

| Field | Source |
|-------|--------|
| `gate_allowed` | `decision.outcome === APPROVED` (or shadow-equivalent `allowed`) |
| `trade_side` | `signal.tradeSide` when present |
| `qty`, `notional`, `leverage` | `decision.approvedSizing` when approved opening |
| `stop_loss`, `take_profit` | `decision.clampedExit` when approved opening |
| `halt_leg` / detail | See H3 |

Skip paths: geometry NULL, `gate_allowed=false` where applicable; strategy skips may have no gate evaluation — keep `gate_allowed` NULL or false consistently (architect lock).

### H3 — Lock halt-leg write rules

| `reason` (coarse) | Populate from |
|-------------------|---------------|
| `market_stress` (rejected at gate) | `StressHaltEvaluator.classifyHaltLeg(snapshot, params)` → store `market_stress:${leg}` or leg column |
| `global_halt` | Read today’s `risk_state.halt_reason` via `riskStatePort` (same source M23 resume uses) |
| Other rejects / skips | `NULL` |

QA must assert breadth-only auto-resume rows show `breadth`, multi-leg halts show `multi`, loss halts show `daily_loss_breach` (or whatever `risk_state` carries) — not re-derived from snapshot alone on historical `global_halt` rows.

### H4 — `book_snapshots` retention: replace “mirror partitioning”

Only `tick_aggregates` has daily RANGE partitions (`TickAggregatePartitionService`). `book_snapshots` is a **non-partitioned** table with sparse future write volume (one row per volatility trigger, not per tick).

Architect should specify:

- **Unique index** on `event_id` (one book row per trigger).
- **Retention:** e.g. 90-day (align with `tick_aggregates` window) via scheduled `DELETE WHERE ts < cutoff` or partition-on-add if volume surprises — not “mirror partitioning” without a design.
- **Optional column `mid_at_trigger`** (numeric) on the same migration as `event_id` — maps ADR 0005 and unblocks forensic IOC reference without another migration churn.

Writer hook: prefer `@OnEvent(VOLATILITY_DETECTED_EVENT)` in `MarketDataPersistenceListener` (passive, not order path) **or** call from `StrategyService` immediately before/after `decisions.record` with the same `eventId` — architect picks one to avoid double-writes.

### H5 — Behaviour-unchanged test: gate fingerprint, not only funnel mix

Post-deploy funnel comparison (plan step 5) is useful but noisy under M25 concurrency/stress changes. **Load-bearing unit/integration test:** fixed `(intent, context snapshot, risk_state fixture)` set → identical `IRiskDecision` before/after M27. Persist layer tests are separate.

Also assert `buildGateContext` still receives snapshot with `active_positions_count: 0` **if** count is stamped only post-evaluate (gate must not see the fix prematurely).

### H6 — Zod guard: inject `AppConfigService` / `EXCHANGE_ENV`

`DecisionRepository` needs config to choose throw vs warn. Pattern:

- `EXCHANGE_ENV === 'live'` → warn-only (never drop production decisions).
- Else → `safeParse` failure throws before `save`.

Add adversarial test mirroring existing `DecisionRepository.marketSnapshot.spec.ts`.

---

## Should-fix before dispatch

### M1 — `packages/analysis` / MCP reader follow-on (non-blocking)

`getDecisions` and MCP `DecisionViewSchema` omit new columns. Plan defers dashboard — acceptable. Add a **single MEDIUM tech-debt** line for analysis SDK projection of geometry columns when soak agents need them (raw SQL works without code).

### M2 — `position_id` backfill linkage

`DecisionEntity.position_id` exists but `persistDecision` does not set it today. M27 could link approved opens when the position row exists — likely **after** execution, not at decision time. Do not block M27; note as optional follow-on once M24 fills land.

### M3 — Correlated-bar loser rows

`flushBar` calls `recordRejection` for losers with `BTC_CORRELATED_NOT_BEST_CANDIDATE` — geometry NULL, `gate_allowed=false`. Explicit QA row.

### M4 — Two migrations, two dumps

Plan already says dump before dispatch A and C. Confirm **decisions migration** and **book_snapshots migration** are separate files — do not combine into one dispatch >5 files.

### M5 — Schema validation bootstrap

`SchemaValidationService` lists `book_snapshots` required columns `['symbol', 'ts']` — update after migration so boot fails fast if `event_id` index missing.

### M6 — Pre-requisite verification

Meaningful 24–48h capture confirmation (plan post-deploy step 4) needs **M24 fills + M25 approvals** producing gate-approved opens. Orchestrator should confirm those milestones deployed before treating empty geometry on new opens as a failure.

---

## What looks good

- **Problem statement** matches architect §4 and WIP gap analysis verbatim — accurate.
- **Observability-only invariant** with explicit “records, never decides” — essential for risk culture.
- **Additive nullable migration policy** — correct for soak DB with irreplaceable history.
- **Shared-first dispatch** — appropriate when entity columns may need shared types for analysis.
- **Split engine dispatches** (schema → population → book → Zod) — respects ≤5-file cap.
- **Shadow entity as parity target** — reduces design ambiguity.
- **Parallel with M26** — no file overlap (shadow fills vs decision capture).
- **DB safety section** — strongest in the arc; M27 is the first migration milestone.
- **Tech-debt scribe item** for measured slippage — correctly defers to post-fill telemetry (M22).
- **Dashboard defer** — ADR 0022 contract stability.

---

## Consciously out of scope (agree with plan)

- Measured slippage replacing tier `estimated_slippage_pct`.
- Gate/threshold/slot changes (M25).
- Fill production (M24/M26).
- `IDecisionView` / dashboard surfacing of new fields (unless operator asks).
- Backfilling geometry onto pre-M27 decision rows.

---

## Dispatch adjustments (concrete)

1. **Architect wave:** ADR note — observability-only; lock halt-leg column semantics; lock book row columns (`event_id`, optional `mid_at_trigger`); lock writer event hook; lock retention policy (not generic “partitioning”).
2. **Shared maintainer:** Halt-leg type union if needed; **no** `marketSnapshotSchema` geometry keys; optional `IDecisionGeometry` interface for analysis exports.
3. **Engine A:** `DecisionEntity` + migration (`gate_allowed`, `trade_side`, `qty`, `stop_loss`, `take_profit`, `notional`, `leverage`, `halt_leg` or `halt_reason_detail` — names per ADR).
4. **Engine B:** Refactor `persistDecision` + extend `stampGateVerdict` for `active_positions_count`; remove `ACTIVE_POSITIONS_COUNT_DRY_RUN`.
5. **Engine C:** `book_snapshots` migration (`event_id` UNIQUE, optional `mid_at_trigger`) + writer + retention cron spec.
6. **Engine D:** `DecisionRepository` Zod policy by `EXCHANGE_ENV`.
7. **QA:** Geometry/halt/count/book/Zod suites + **gate fingerprint unchanged** + migration up/down on M16 DB.
8. **Reviewers:** Quant confirms reconstructability (intended trade + regime from row); security confirms migration safety and no PII in new columns.

---

## Post-deploy expectations (amended)

| Check | Pass criterion |
|-------|----------------|
| Migration | New columns exist; `down` clean on test DB; soak dump path recorded |
| Boot | Engine running; `SchemaValidationService` green |
| Geometry | Gate-approved opens after M24 have non-NULL qty/SL/TP/side; rejects have `gate_allowed=false` |
| Halt leg | `market_stress` / `global_halt` rows carry specific leg; matches `risk_state` for same UTC day |
| Position count | `market_snapshot.active_positions_count` matches open book when positions held; 0 when flat |
| Book rejoin | `SELECT * FROM book_snapshots b JOIN decisions d ON d.event_id = b.event_id` returns rows on triggers |
| Behaviour | Gate fingerprint tests green; funnel mix optional / confounded if M25 deployed same window |

---

## References consulted

- Plan: `docs/plans/archive/M27-decision-data-capture-completeness.md`
- Architect P5: `docs/wip/done/main-architector-paper-soak-fill-and-gate-analysis.md` §4, §5
- Entities: `DecisionEntity.ts`, `ShadowDecisionEntity.ts`, `BookSnapshotEntity.ts`
- Writers: `StrategyService.ts`, `DecisionRepository.ts`, `ShadowStrategyOrchestratorService.ts`
- Halt legs: `StressHaltEvaluator.ts`, `riskConsts.ts` (M23 suffix tokens)
- ADR 0005 `mid_at_trigger` deferral: `docs/plans/archive/M5-execution-testnet.md` carry-over
- Read contract: `packages/shared/src/interface/IDecisionView.ts`, ADR 0022

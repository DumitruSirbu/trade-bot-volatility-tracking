# Independent Review - M27 Decision Data-Capture Completeness

**Reviewer:** GBT (independent)  
**Plan reviewed:** `docs/plans/M27-decision-data-capture-completeness.md`  
**Date:** 2026-06-08

## Verdict

I approve M27's intent. The data-capture gaps are real: live `decisions` rows currently do not carry
the intended trade geometry, halt details are only durable by UTC day in `risk_state`, the snapshot
position count is a hard-coded zero, and `book_snapshots` has schema/repository scaffolding but no live
writer. Fixing these is necessary before paper/shadow outcomes can become a useful training dataset.

I would not dispatch M27 as written. It combines several schema, shared-contract, read API, and
runtime-capture changes under an "observability only" umbrella, but a few of those changes can affect
paper execution if implemented literally. In particular, making decision Zod validation hard in paper
can stop approved orders before `ORDER_INTENT_APPROVED_EVENT` is emitted, halt-leg capture cannot be
reliably reconstructed from date joins for each decision, and "mirror partitioning" for
`book_snapshots` is not an additive nullable migration on the current table.

## Must-Fix Before Dispatch

### H1 - Hard Zod validation in paper can change trading behavior

The plan says malformed decision snapshots should throw in test/paper and warn only in live. That
breaks the milestone's observability-only invariant because the current active path persists the gate
decision before emitting an approved order:

```290:305:apps/engine/src/strategy/service/StrategyService.ts
    private async gateAndPersist(
        event: IVolatilityDetectedEvent,
        snapshot: IMarketSnapshot,
        signal: ISignal,
        intent: IOrderIntent,
        nowMs: number,
    ): Promise<void> {
        const context = await this.buildGateContext(event.symbol, snapshot, nowMs);
        const decision = await this.riskGate.evaluate(intent, context);
        const stampedSnapshot = this.stampGateVerdict(snapshot, decision);

        await this.recordGateDecision(event, stampedSnapshot, signal, intent, decision);

        if (isApprovedOpening(decision)) {
            this.emitApproval(intent, decision);
        }
    }
```

`recordGateDecision` eventually calls `DecisionRepository.record`, whose validation is currently
warn-only:

```22:26:apps/engine/src/strategy/repository/DecisionRepository.ts
    async record(decision: Partial<DecisionEntity>): Promise<DecisionEntity> {
        this.validateMarketSnapshot(decision);

        return this.repository.save(this.create(decision));
    }
```

If M27 changes this to throw in paper, a schema drift can prevent a gate-approved paper open from ever
reaching the paper fill simulator. That is not "capture only"; it changes whether trades happen.

Required plan change:

- Do not make hard validation active in `EXCHANGE_ENV=paper` while paper is the running soak
  environment, unless the approval emit path is made independent of decision persistence failures.
- Prefer one of these contracts:
  - hard only in unit/integration test and local dev, warn in paper/live;
  - hard in paper only for offline validation jobs, not the live event handler;
  - move approval emit before best-effort persistence and prove persistence failures cannot block
    order execution.
- Add an adversarial test: an approved opening with malformed capture data still emits
  `ORDER_INTENT_APPROVED_EVENT` if M27 claims behavior unchanged.

Without this correction, M27 can reintroduce a zero-trade paper symptom through the observability path.

### H2 - Halt-leg capture needs gate-owned metadata, not date joins or post-hoc reclassification

The plan offers either an on-row halt leg or a `decisions.date -> risk_state.date` helper. The helper
is not precise enough for per-decision analysis. A decision rejected with `global_halt` may refer to a
halt written earlier in the day; a fresh `market_stress` rejection writes the leg inside
`RiskGateService.persistHalt`; and M23 auto-resume can clear the row later. A date join is therefore a
mutable day-state lookup, not a stable decision fact.

The gate builds the durable leg internally:

```826:846:apps/engine/src/risk/service/RiskGateService.ts
    private async persistHalt(context: IRiskGateContext, state: ILoadedState, reason: RejectReasonEnum): Promise<void> {
        if (state.today !== null && state.today.isHalted) {
            return;
        }

        const base = state.today ?? this.emptyDay(context.utcDateString);
        const haltReason = this.buildPersistedHaltReason(context, reason);

        await context.riskState.upsertDay({ ...base, isHalted: true, haltReason });
    }

    // The persisted halt_reason string. market_stress carries the classified trigger-leg suffix
    // (ADR 0004 §6d); every other reason is written as the bare enum value, unchanged.
    private buildPersistedHaltReason(context: IRiskGateContext, reason: RejectReasonEnum): string {
        if (reason !== RejectReasonEnum.MARKET_STRESS) {
            return reason;
        }

        const leg = this.stress.classifyHaltLeg(context.snapshot, context.params);
```

But the public risk decision does not carry that detailed halt reason:

```9:16:apps/engine/src/risk/interface/IRiskDecision.ts
export interface IRiskDecision {
    readonly outcome: RiskOutcomeEnum; // approved | rejected
    readonly rejectReason: RejectReasonEnum | null; // non-null IFF rejected
    readonly approvedSlot: PositionSlotEnum | null; // A|B|C, non-null IFF approved & opening
    readonly approvedSizing: IIntentSizing | null; // post-clamp sizing (funding 50% cut etc.)
    readonly clampedExit: IProposedExit | null; // SL possibly tightened to sit inside liquidation
    readonly reservationId: string | null; // ledger handle (§3), non-null IFF approved
}
```

Required plan change:

- Prefer on-row halt detail and make `RiskGateService` return it as immutable metadata on
  `IRiskDecision`, for example `haltReasonDetail: string | null`.
- For already-halted-day rejects, return the loaded `state.today.haltReason`; for fresh market-stress
  rejects, return the same string passed to `risk_state.upsertDay`.
- Do not recompute the leg in `StrategyService`; that risks drift from the gate's actual persisted
  reason and from future M25 paper-relax semantics.
- Drop the date-join helper as an acceptance-equivalent option. It may remain a legacy analysis helper,
  but it should not be the M27 fix.

### H3 - The plan blurs top-level decision columns with `market_snapshot` schema

M27 correctly asks to add top-level `decisions` columns for trade geometry:

```14:52:apps/engine/src/strategy/entity/DecisionEntity.ts
@Entity({ name: 'decisions', synchronize: false })
@Index('idx_decisions_strategy_version_id_ts', ['strategyVersionId', 'ts'])
@Index('idx_decisions_event_id', ['eventId'])
export class DecisionEntity {
    @PrimaryGeneratedColumn({ name: 'decisions_id' })
    id!: number;
    // ...
    @Column({ name: 'market_snapshot', type: 'jsonb' })
    marketSnapshot!: IMarketSnapshot;

    @Column({ name: 'action', type: 'varchar' })
    action!: string;
```

But the plan also says `packages/shared/` should update `marketSnapshotSchema` with
`gate_allowed`, side, SL/TP, qty/notional, and halt-leg. That schema is currently strict and describes
market context, not the intended order:

```6:12:packages/shared/src/schema/marketSnapshotSchema.ts
export const marketSnapshotSchema = z
    .object({
        vwap_session: z.string().regex(DECIMAL_REGEX),
        vwap_20bar: z.string().regex(DECIMAL_REGEX),
        vwap_deviation_pct: z.number(),
        vwap_deviation_sigma: z.number(),
```

Putting trade geometry into `market_snapshot` duplicates the proposed columns and makes snapshot data
mean two things at once. It also risks strict-schema churn for every decision row.

Required plan change:

- Separate contracts:
  - top-level `decisions` columns: `gate_allowed`, `trade_side`, `stop_loss`, `take_profit`, `qty`,
    `notional`, `leverage`, `halt_reason_detail`;
  - `market_snapshot`: keep market-only fields, but fix `active_positions_count` there because it is
    already a snapshot field.
- Update `IDecisionView` separately if API/dashboard consumers need these fields:

```4:15:packages/shared/src/interface/IDecisionView.ts
export interface IDecisionView {
    id: string;
    occurredAt: string;
    symbol: string;
    action: SignalActionEnum;
    flowType: FlowTypeEnum;
    signalScore: string | null;
    reason: string | null;
    strategyVersionId: string;
    eventId: string;
    positionId?: string | null;
}
```

- Make the shared wave own `IDecisionView` and read API DTO updates, not just
  `marketSnapshotSchema`.

### H4 - `book_snapshots` retention/partitioning is not additive on the current table

The plan requires the live writer to respect bounded retention and says to mirror existing
market-data partitioning. Current `book_snapshots` is a simple non-partitioned table:

```191:203:apps/engine/src/database/migrations/20260522010000-CreateSchema.ts
    private async createBookSnapshots(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "book_snapshots" (
                "book_snapshots_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "ts" timestamptz NOT NULL,
                "spread" numeric(18, 8),
                "depth_10bps" numeric(38, 8),
                "depth_50bps" numeric(38, 8),
                CONSTRAINT "pk_book_snapshots" PRIMARY KEY ("book_snapshots_id")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_book_snapshots_symbol_ts" ON "book_snapshots" ("symbol", "ts")');
```

Converting an existing table to daily partitions is not an additive nullable migration. A retention
job that bulk-deletes old rows also touches operational data and falls under the repo's DB safety
rules. This is too large to leave as a parenthetical.

Required plan change:

- Split the book-snapshot work into two decisions:
  - M27a: additive `event_id` column/index and best-effort writer;
  - follow-up ADR/milestone: retention design for `book_snapshots` (partition migration vs bounded
    delete job), with explicit DB safety and data-retention policy.
- If retention remains in M27, require an architect-owned schema plan. Do not describe it as "mirror
  existing partitioning" unless the migration steps and reversibility are specified.
- Add a uniqueness/idempotency decision for `event_id`. If one decision should have one book snapshot,
  add a nullable unique index on `event_id` for non-null rows; otherwise define how duplicate snapshots
  are handled.

### H5 - Book snapshot source is under-specified and may not capture true L2

`IVolatilityDetectedEvent` carries spread percent and depth aggregates, but not raw best bid/ask or
full order-book levels:

```52:55:packages/shared/src/interface/IVolatilityDetectedEvent.ts
    // order-book / spread (captured around trigger)
    bidAskSpreadPct: number;
    bookDepth10bpsUsdt: string; // decimal-as-string (USDT notional)
    bookDepth50bpsUsdt: string; // decimal-as-string (USDT notional)
```

The current `BookSnapshotEntity` can store only spread/depth, not bid/ask/mid or depth levels:

```14:27:apps/engine/src/market-data/entity/BookSnapshotEntity.ts
    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'spread', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    spread?: MoneyValue | null;

    @Column({ name: 'depth_10bps', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
```

M27 describes this as "trigger-time L2 microstructure." That is too broad for the current event/entity
shape.

Required plan change:

- Define the exact book snapshot scope for M27: spread percent + depth 10/50bps only, or raw bid/ask
  and levels.
- If raw L2 is required, this is a larger shared/event/entity change because the live trigger event
  does not carry those fields today.
- If aggregate spread/depth is enough, change the wording from "L2 microstructure" to "trigger-time
  spread/depth aggregates" and test only those fields.

## Should-Fix Before Dispatch

### M1 - Define `active_positions_count` semantics precisely

The current mapper hard-codes zero:

```44:48:apps/engine/src/strategy/mapper/marketSnapshotMapper.ts
        correlation_mode: resolveCorrelationMode(input),
        signal_score: signalScore,
        position_slot: PositionSlotEnum.A,
        active_positions_count: ACTIVE_POSITIONS_COUNT_DRY_RUN,
        regime_label: event.regimeLabel,
```

The "real count at decision time" can mean different things:

- DB open positions before the current gate decision;
- DB open positions plus in-memory reservations;
- DB open positions after a gate approval but before the paper fill opens a position;
- symbol-specific count vs portfolio-wide count.

Recommended addition:

- Define it as portfolio-wide open position count before evaluating the current decision, unless the
  architect explicitly wants pending reservations included.
- Do not run another `findOpen()` after the gate if that can see a different state than the gate
  loaded. Ideally thread the count from the same state load used by the gate, or add read-only metadata
  to `IRiskDecision`.

### M2 - Rejected/pre-gate rows need explicit null geometry rules

`IOrderIntent` contains trade side, proposed exits, and sizing:

```10:31:apps/engine/src/risk/interface/IOrderIntent.ts
export interface IOrderIntent {
    readonly intentAction: OrderIntentActionEnum; // open|add|reduce|close|flatten (§2)
    readonly symbol: string;
    readonly eventId: string; // ties back to the trigger / decision
    readonly tradeSide: PositionSideEnum; // long|short, set by the strategy; gate NEVER flips
    // ...
    readonly proposedExit: IProposedExit; // strategy SL/TP/time-stop (ADR 0003 §3)
    readonly openPosition: IOpenPositionState | null; // for add/reduce/close; null for open
    readonly sizing: IIntentSizing; // §8 concrete decimal sizing
```

Pre-gate skips do not always have an `IOrderIntent`; gate rejects do. The plan should say exactly
which fields are populated for each class of row:

- strategy skip: `gate_allowed=null` or `false`?
- pre-gate open skip due missing instrument/sizing: side may exist but qty/notional does not;
- gate reject: side/SL/TP/qty should be populated from intent/proposed exit;
- gate approval: use `decision.clampedExit`, not raw `intent.proposedExit`, for the final intended
  SL/TP.

### M3 - Add the read API mapper to the change set if fields must be operator-visible

The current read mapper enumerates `IDecisionView` fields explicitly:

```146:160:apps/engine/src/read-api/mappers/readApiMappers.ts
export function mapDecision(decision: DecisionEntity): IDecisionView {
    return {
        id: String(decision.id),
        occurredAt: decision.ts.toISOString(),
        symbol: decision.symbol,
        action: decision.action as SignalActionEnum,
        flowType: decision.signalType as FlowTypeEnum,
        // ADR 0022 §2.3.1: `null` distinguishes "skip decision had no score"
        // from "score was literally 0"; empty-string `reason` likewise ambiguous.
        signalScore: extractSignalScore(decision),
        reason: decision.reason ?? null,
        strategyVersionId: String(decision.strategyVersionId),
        eventId: decision.eventId,
        positionId: decision.positionId === null || decision.positionId === undefined ? null : String(decision.positionId),
```

Adding columns without updating `IDecisionView` and `mapDecision` is fine for SQL analysis, but not for
API/dashboard analysis. M27 should state which surface is the acceptance target.

### M4 - Keep decision persistence best-effort around the order path

`MarketDataPersistenceListener` intentionally swallows persistence errors so market-data writes never
destabilize the trade loop:

```144:160:apps/engine/src/market-data/service/MarketDataPersistenceListener.ts
    // Single try/catch wrapper so error handling is one thing. A duplicate-key collision
    // is the idempotency happy path (concurrent re-emit) → warn + swallow; anything else
    // is logged at error and swallowed so persistence never destabilises the trade loop.
    private async persist(target: string, write: () => Promise<unknown>): Promise<void> {
        try {
            await write();
        } catch (cause) {
```

M27 should apply the same principle to any new book-snapshot writer and be cautious with decision
persistence hard failures. Observability writes should not become a second risk gate.

## What Looks Good

- The main data gaps match the code and the WIP analysis.
- Additive nullable `decisions` columns are the right migration posture for old soak rows.
- Routing shared-contract changes through `bot-shared-maintainer` is correct.
- The plan correctly treats measured slippage as a follow-up after fills accrue.
- Requiring migration tests on the isolated test DB before touching the soak DB is appropriate.
- The behavior-unchanged test is essential; keep it as a load-bearing acceptance gate.

## Recommended Dispatch Adjustment

I would split M27 into smaller milestones:

1. **M27a - Decision geometry and halt detail:** additive nullable columns, `IRiskDecision` metadata
   for halt detail/position count, decision writer population, read DTO decision if needed.
2. **M27b - Book snapshot event keying:** additive nullable `event_id` + writer for spread/depth
   aggregates, with idempotency and best-effort error handling.
3. **M27c - Capture validation policy:** hard validation only where it cannot block the paper/live
   order path, or a reworked emit/persist order that proves approved orders still execute.
4. **Follow-up - Book snapshot retention:** separate ADR/schema plan if partitioning or bulk pruning is
   required.

With these changes, M27 becomes a safe observability milestone. As written, it is directionally right
but too broad, and parts of it can affect order emission or require non-additive database work.

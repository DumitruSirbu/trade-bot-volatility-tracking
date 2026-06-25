import { ExitReasonEnum, IPositionStateTransitionedEvent, IPriceUpdateEvent, PositionSideEnum, PositionStateEnum } from '@bot/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';

import { POSITION_OPENED_EVENT, PRICE_UPDATE_EVENT } from '../../common/const';
import { IPositionOpenedEvent } from '../../common/interface';
import { Money, MoneyValue } from '../../common/utils/money';
import { RiskGateService } from '../../risk/service/RiskGateService';
import {
    computeExcursionPct,
    computeStopGapPct,
    updateMaePct,
    updateMarkVsLastMaxDivergencePct,
    updateMfePct,
    updateMinLiquidationDistancePct,
    updateTimeToReversionSecs,
} from '../util/instrumentationMath';
import { INSTRUMENTATION_FLUSH_INTERVAL_MS, POSITION_STATE_TRANSITIONED_EVENT } from '../const';
import { PositionEntity } from '../entity';
import { PositionRepository } from '../repository/PositionRepository';

// R1.3.3 mechanical move: the const declaration relocated to
// `position/const/instrumentationConsts.ts`. Re-export preserved so callers
// that imported via the service path keep compiling.
export { INSTRUMENTATION_FLUSH_INTERVAL_MS } from '../const';

// ADR 0013 §1 — the in-memory accumulator per position. All fields are
// nullable: a position may exist without ever having seen a price tick (e.g.
// `pending_open` → reconciliation drift → closed), in which case the metrics
// stay null and the persisted row carries the DB defaults from M2.
//
// The `dirty` flag is the §4 "no-op-write" guard: only positions whose
// accumulator changed since the last flush are persisted on the next tick.
interface IInstrumentationState {
    readonly positionId: number;
    readonly side: PositionSideEnum;
    readonly entryPrice: MoneyValue;
    readonly vwapAtEntry: MoneyValue | null;
    readonly openedAtMs: number;
    maePct: MoneyValue | null;
    mfePct: MoneyValue | null;
    timeToReversionSecs: number | null;
    markVsLastMaxDivergencePct: MoneyValue | null;
    minLiquidationDistancePct: MoneyValue | null;
    liquidationPrice: MoneyValue | null;
    dirty: boolean;
}

// Read-API shape — what `getLifeStats` returns to M9 / dashboard consumers.
// Mirrors the persisted-column subset the instrumentor owns.
export interface IPositionLifeStats {
    readonly positionId: number;
    readonly maePct: MoneyValue | null;
    readonly mfePct: MoneyValue | null;
    readonly timeToReversionSecs: number | null;
    readonly markVsLastMaxDivergencePct: MoneyValue | null;
    readonly minLiquidationDistancePct: MoneyValue | null;
}

// ADR 0013 §3 — separate service from `PositionService` (Single Responsibility:
// `PositionService` owns state transitions and the canonical row; this service
// owns derived statistics over the position's life). Subscribes to
// `price.update` for §§1a/1b/1c/1f/1g metrics and to
// `position.state.transitioned` for the close-time `stop_gap_pct` (§1d) plus
// the closed-position flush.
//
// Sampling cadence (§2): `price.update` is the only sample event for the
// price-driven metrics. Filters to symbols whose position state is in
// `{pending_open, open, closing}`; `reconciling` and
// `manual_adopted_unmanaged` rows are skipped (drift state corrupts the
// analytic). `pending_open` is included because the local monitor is the
// only protection in that window (ADR 0008 §2) and capturing MAE/MFE during
// it is valid.
//
// Persistence cadence (§4): periodic `@Interval(INSTRUMENTATION_FLUSH_INTERVAL_MS)`
// + a synchronous flush on the CLOSED transition. The §4 reviewer rule
// "exactly one UPDATE per flush window for N synthetic ticks" is enforced
// by the `dirty` flag: a tick that does not change any accumulator value
// does not mark the position dirty, and a flush only writes positions whose
// dirty flag is set since the last flush.
//
// Determinism (§ADR 0013 §intro): `nowMs` reads are bounded to the
// `@Interval` callback and the `@OnEvent` price-tick handler — both
// boundaries match the W3 LocalProtectiveMonitor + ReconciliationService
// pattern (ADR 0004 §7). The pure metric updaters take `nowMs` as a
// parameter so backtest replay drives them with the replay clock identically.
//
// CONTRACT GAP — mark vs last (§1f): `IPriceUpdateEvent` in
// `packages/shared/src/interface/IPriceUpdateEvent.ts` carries a single
// `price: string` field, NOT a `(markPrice, lastPrice)` split. The
// instrumentor exposes `updateMarkVsLastMaxDivergencePct` for when the split
// lands (shared-contract change routed through `bot-shared-maintainer`); for
// now `mark_vs_last_max_divergence_pct` stays null on every position because
// no caller passes two distinct prices. Surfaced as a W6 contract gap.
@Injectable()
export class PositionInstrumentor {
    private readonly logger = new Logger(PositionInstrumentor.name);

    private readonly states = new Map<number, IInstrumentationState>();

    // Symbol → set of positionIds with an open accumulator. Keeps the
    // `price.update` handler O(1) on symbol miss (the engine streams
    // `price.update` for the entire universe; the instrumentor only acts
    // on symbols where it tracks a position).
    private readonly positionsBySymbol = new Map<string, Set<number>>();

    constructor(
        private readonly positions: PositionRepository,
        // M6 W8.5 boot-race guard. Skip scheduled flushes until phase 9 opens
        // the orchestrator. Event-driven handlers (onPriceUpdate,
        // onPositionStateTransitioned, onPositionOpenedEvent) are NOT gated —
        // the accumulator continues to absorb ticks during boot so no data
        // is lost; only the DB UPDATE is deferred. forwardRef because
        // RiskModule imports PositionModule for repositories.
        @Inject(forwardRef(() => RiskGateService))
        private readonly riskGate: RiskGateService,
    ) {}

    // ADR 0013 §3 + §4 — entry point for a newly-opened position. Seeds the
    // accumulator with the immutable entry-time fields and registers the
    // symbol index. Idempotent: re-opening (e.g., bootstrap re-seed from
    // ADR 0014 §3) overwrites the prior in-memory entry. Mutable analytic
    // values (mae, mfe, etc.) are seeded from the persisted row so a
    // bootstrap recovers the pre-crash state (§5 reviewer rule).
    onPositionOpened(position: PositionEntity): void {
        const state: IInstrumentationState = {
            positionId: position.id,
            side: position.side,
            entryPrice: position.entryPrice,
            vwapAtEntry: position.vwapAtEntry ?? null,
            openedAtMs: position.openedAt.getTime(),
            maePct: position.maePct ?? null,
            mfePct: position.mfePct ?? null,
            timeToReversionSecs: position.timeToReversionSecs ?? null,
            markVsLastMaxDivergencePct: position.markVsLastMaxDivergencePct ?? null,
            minLiquidationDistancePct: position.minLiquidationDistancePct ?? null,
            liquidationPrice: null, // updated by `setLiquidationPrice` from the reconciliation tick
            dirty: false,
        };

        this.states.set(position.id, state);
        this.indexSymbol(position.symbol, position.id);

        this.logger.debug(`instrumentation seeded positionId=${position.id} symbol=${position.symbol} side=${position.side}`);
    }

    // M47 Task 5a (tech-debt M7) — synchronous entry-tick seed. Called by ExecutionService
    // immediately after `onPositionOpened` on the open path, BEFORE the first downstream await,
    // so the entry-instant peak-excursion window is captured rather than lost to the async
    // seed-timing race. Applies the entry price as the initial excursion sample: mark ≈ entry at
    // open, so the excursion is zero and both columns seed to 0 under the signed convention
    // (`mfe_pct >= 0` via `max`, `mae_pct <= 0` via `min`). Seeds SIGNED PERCENTAGES, never the
    // entry price itself. No-ops if the position is not tracked (onPositionOpened must run first).
    applyEntryTick(position: PositionEntity): void {
        const state = this.states.get(position.id);

        if (state === undefined) {
            return;
        }

        this.applyTick(state, position.entryPrice, position.openedAt.getTime());
    }

    // ADR 0013 §1g — the reconciliation tick (ADR 0010 §2) refreshes liquidation
    // prices via `exchange.fetchPositions()`. The instrumentor caches the latest
    // per position so `onPriceUpdate` can compute the signed distance without
    // re-reading the exchange. Public so the boot pipeline (W8) can also seed
    // from the snapshot read.
    setLiquidationPrice(positionId: number, symbol: string, liquidationPrice: MoneyValue | null): void {
        const state = this.states.get(positionId);

        if (state === undefined) {
            return; // position not tracked (closed, reconciling, etc.)
        }

        // Defensive symbol-mismatch guard: a stale id reuse would otherwise
        // corrupt the wrong position's distance. The symbol comes from the
        // exchange snapshot; the state's symbol is fetched via the index lookup.
        if (!this.symbolHasPosition(symbol, positionId)) {
            return;
        }

        state.liquidationPrice = liquidationPrice;
        // Not marked dirty here: liquidation price alone does not change the
        // persisted columns. The next `onPriceUpdate` recomputes
        // `minLiquidationDistancePct` using the new liquidation price and
        // sets dirty as needed.
    }

    // ADR 0013 §2 — the sole sampling event for §§1a/1b/1c/1f/1g. Filters by
    // symbol first (O(1) miss), then per tracked position. Skips positions
    // whose state has reached a terminal/excluded value (`reconciling`,
    // `manual_adopted_unmanaged`, `closed`) — the in-memory map is the
    // authoritative filter; entries are removed on state transitions into
    // those states by `onPositionStateTransitioned`.
    @OnEvent(PRICE_UPDATE_EVENT)
    onPriceUpdate(event: IPriceUpdateEvent): void {
        const positionIds = this.positionsBySymbol.get(event.symbol);

        if (positionIds === undefined || positionIds.size === 0) {
            return;
        }

        const markPrice = this.parsePrice(event.price);

        if (markPrice === null) {
            return;
        }

        const nowMs = event.timestampMs;

        for (const positionId of positionIds) {
            const state = this.states.get(positionId);

            if (state === undefined) {
                continue;
            }

            this.applyTick(state, markPrice, nowMs);
        }
    }

    // ADR 0013 §1d + §4 — close-time hook. On `toState === CLOSED` we
    // synchronously flush the position's accumulator and compute
    // `stop_gap_pct` from the row's exit reason + fill price + SL level. Then
    // we remove the in-memory entry so the next price.update for the symbol
    // does not re-touch this position.
    //
    // On `toState === RECONCILING` or `MANUAL_ADOPTED_UNMANAGED` we remove the
    // entry without flushing (drift state stats are not persisted — §2).
    //
    // On `toState === CLOSING` we keep the entry (closing positions still
    // accrue MAE/MFE on subsequent reduce ticks per §1a sample event).

    // M6 W7 wiring (resolves W6 carry-forward #3). ExecutionService emits
    // POSITION_OPENED_EVENT with `{ positionId, symbol }` after a fresh row
    // is inserted; we read the row via the repository and seed the
    // accumulator. Defensive on missing rows (race window between event
    // and DB visibility, or the row was deleted) — log + skip.
    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpenedEvent(event: IPositionOpenedEvent): Promise<void> {
        await this.seedFromRow(event.positionId, 'opened');
    }

    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    async onPositionStateTransitioned(event: IPositionStateTransitionedEvent): Promise<void> {
        if (event.toState === PositionStateEnum.RECONCILING || event.toState === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
            this.dropPosition(event.positionId);

            return;
        }

        // M6 R1.3.5 (ADR 0014 §4a revised). Operator ack promotes a foreign-
        // adopted position into the slot model via the
        // MANUAL_ADOPTED_UNMANAGED → OPEN arrow. Before this hook, the
        // accumulator was never seeded for adopted positions — ADR 0013 §2
        // explicitly excludes MANUAL_ADOPTED_UNMANAGED ticks from sampling,
        // so MAE/MFE/timeToReversion stayed null forever once the operator
        // accepted ownership. Mirrors the executor's POSITION_OPENED_EVENT
        // seeding path: read the freshest row and seed the in-memory
        // accumulator so the next `price.update` for the symbol starts
        // accruing analytic columns from the ack instant.
        if (event.fromState === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED && event.toState === PositionStateEnum.OPEN) {
            await this.seedFromRow(event.positionId, 'adoption-ack');

            return;
        }

        // M6 R4.1.1 (ADR 0013 §5 bootstrap re-seed invariant). R3.1.1
        // unblocked the RECONCILING → OPEN edge in production via the
        // case-(f) terminal-survived path. The instrumentor previously
        // dropped the accumulator on entry into RECONCILING; without a
        // symmetric re-seed on recovery the row would resume operating
        // with null analytics for the rest of its lifetime, exactly the
        // same pathology the MANUAL_ADOPTED_UNMANAGED → OPEN branch
        // already fixes. Mirror that seeder: read the freshest row and
        // re-seed so the next `price.update` accrues MAE/MFE from the
        // recovery instant.
        if (event.fromState === PositionStateEnum.RECONCILING && event.toState === PositionStateEnum.OPEN) {
            await this.seedFromRow(event.positionId, 'reconcile-recover');

            return;
        }

        if (event.toState !== PositionStateEnum.CLOSED) {
            return;
        }

        await this.handleClose(event.positionId);
    }

    // Shared seeder used by `onPositionOpenedEvent` (executor open path), the
    // adoption-ack branch, and the reconcile-recover branch above. Defensive
    // on missing rows (race window between event and DB visibility, or the
    // row was deleted).
    private async seedFromRow(positionId: number, source: 'opened' | 'adoption-ack' | 'reconcile-recover'): Promise<void> {
        const position = await this.positions.findById(positionId);

        if (position === null) {
            this.logger.warn(`instrumentor seed (${source}) positionId=${positionId} but row not found - skipping`);

            return;
        }

        this.onPositionOpened(position);
    }

    // ADR 0013 §4 — periodic batched flush. Iterates dirty accumulators and
    // issues one UPDATE per dirty position. Clean accumulators are skipped
    // entirely (reviewer rule: "exactly one UPDATE statement for N synthetic
    // ticks within a flush window").
    @Interval(INSTRUMENTATION_FLUSH_INTERVAL_MS)
    async flushPending(): Promise<void> {
        // M6 W8.5 boot-race guard. Skip scheduled flushes until phase 9 opens
        // the orchestrator; in-memory accumulator updates continue so no
        // sample data is lost — only the DB UPDATE is deferred. A close-time
        // sync flush via `onPositionStateTransitioned` is event-driven and
        // not affected by this guard.
        if (!this.riskGate.isRecoveryReady()) {
            this.logger.debug('scheduled instrumentation flush skipped: boot recovery not yet complete');

            return;
        }

        try {
            await this.flushDirtyStates();
        } catch (cause) {
            this.logger.error(`instrumentation flush failed: ${this.describe(cause)}`);
        }
    }

    // M9 read-API entry point (ADR 0013 §4): subsecond-fresh life stats from
    // the in-memory accumulator. Returns null when the position is not
    // tracked (closed, reconciling, or never opened in this process).
    getLifeStats(positionId: number): IPositionLifeStats | null {
        const state = this.states.get(positionId);

        if (state === undefined) {
            return null;
        }

        return {
            positionId: state.positionId,
            maePct: state.maePct,
            mfePct: state.mfePct,
            timeToReversionSecs: state.timeToReversionSecs,
            markVsLastMaxDivergencePct: state.markVsLastMaxDivergencePct,
            minLiquidationDistancePct: state.minLiquidationDistancePct,
        };
    }

    // ─── internals ─────────────────────────────────────────────────────────

    private applyTick(state: IInstrumentationState, markPrice: MoneyValue, nowMs: number): void {
        const excursion = computeExcursionPct(state.side, state.entryPrice, markPrice);
        let changed = false;

        const nextMae = updateMaePct(state.maePct, excursion);

        if (nextMae !== state.maePct) {
            state.maePct = nextMae;
            changed = true;
        }

        const nextMfe = updateMfePct(state.mfePct, excursion);

        if (nextMfe !== state.mfePct) {
            state.mfePct = nextMfe;
            changed = true;
        }

        const nextReversion = updateTimeToReversionSecs(state.timeToReversionSecs, state.side, state.vwapAtEntry, markPrice, state.openedAtMs, nowMs);

        if (nextReversion !== state.timeToReversionSecs) {
            state.timeToReversionSecs = nextReversion;
            changed = true;
        }

        const nextMinLiqDistance = updateMinLiquidationDistancePct(state.minLiquidationDistancePct, state.side, state.liquidationPrice, markPrice);

        if (nextMinLiqDistance !== state.minLiquidationDistancePct) {
            state.minLiquidationDistancePct = nextMinLiqDistance;
            changed = true;
        }

        // mark_vs_last_max_divergence_pct: the shared `IPriceUpdateEvent` only
        // carries a single `price` field today (no mark/last split). Until
        // bot-shared-maintainer lands the split, every tick passes the same
        // value for both — divergence is structurally zero, so the column
        // stays at its prior value. The helper is wired for the future split.
        const nextDivergence = updateMarkVsLastMaxDivergencePct(state.markVsLastMaxDivergencePct, markPrice, markPrice);

        if (nextDivergence !== state.markVsLastMaxDivergencePct) {
            state.markVsLastMaxDivergencePct = nextDivergence;
            changed = true;
        }

        if (changed) {
            state.dirty = true;
        }
    }

    private async handleClose(positionId: number): Promise<void> {
        const state = this.states.get(positionId);

        if (state === undefined) {
            return; // never tracked, or already dropped
        }

        const position = await this.positions.findById(positionId);

        if (position === null) {
            this.logger.warn(`close-flush positionId=${positionId} - row not found, dropping accumulator`);
            this.dropPosition(positionId);

            return;
        }

        // ADR 0013 §1d: stop_gap_pct is written ONCE at close, ONLY when
        // exit_reason === STOP_LOSS. For any other reason the column stays
        // null per the reviewer rule.
        let stopGapPct: MoneyValue | null = null;

        if (position.exitReason === ExitReasonEnum.STOP_LOSS && position.exitPrice !== null && position.exitPrice !== undefined) {
            stopGapPct = computeStopGapPct(state.side, position.stopLossPrice ?? null, position.exitPrice);
        }

        // Apply accumulator → row, then a single save commits the flush. This
        // is a separate UPDATE from the state transition (§4 "synchronously
        // before finalize" intent honored via event-ordered listener; an
        // ordering tighter than that would require PositionService to call
        // the instrumentor directly — out of scope for this wave).
        position.maePct = state.maePct ?? null;
        position.mfePct = state.mfePct ?? null;
        position.timeToReversionSecs = state.timeToReversionSecs ?? null;
        position.markVsLastMaxDivergencePct = state.markVsLastMaxDivergencePct ?? null;
        position.minLiquidationDistancePct = state.minLiquidationDistancePct ?? null;
        position.stopGapPct = stopGapPct;

        await this.positions.save(position);

        this.logger.log(
            `instrumentation close-flush positionId=${positionId} ` +
                `mae=${state.maePct?.toFixed() ?? 'n/a'} mfe=${state.mfePct?.toFixed() ?? 'n/a'} ` +
                `t2r=${state.timeToReversionSecs ?? 'n/a'} stopGap=${stopGapPct?.toFixed() ?? 'n/a'} ` +
                `minLiqDist=${state.minLiquidationDistancePct?.toFixed() ?? 'n/a'}`,
        );

        this.dropPosition(positionId);
    }

    private async flushDirtyStates(): Promise<void> {
        const dirty: IInstrumentationState[] = [];

        for (const state of this.states.values()) {
            if (state.dirty) {
                dirty.push(state);
            }
        }

        if (dirty.length === 0) {
            return;
        }

        for (const state of dirty) {
            try {
                await this.persistState(state);
                state.dirty = false;
            } catch (cause) {
                this.logger.error(`instrumentation flush positionId=${state.positionId} failed: ${this.describe(cause)} - retry next tick`);
            }
        }
    }

    private async persistState(state: IInstrumentationState): Promise<void> {
        const position = await this.positions.findById(state.positionId);

        if (position === null) {
            this.logger.warn(`flush positionId=${state.positionId} - row not found, dropping accumulator`);
            this.dropPosition(state.positionId);

            return;
        }

        position.maePct = state.maePct ?? null;
        position.mfePct = state.mfePct ?? null;
        position.timeToReversionSecs = state.timeToReversionSecs ?? null;
        position.markVsLastMaxDivergencePct = state.markVsLastMaxDivergencePct ?? null;
        position.minLiquidationDistancePct = state.minLiquidationDistancePct ?? null;

        await this.positions.save(position);
    }

    private dropPosition(positionId: number): void {
        const state = this.states.get(positionId);

        if (state === undefined) {
            return;
        }

        this.states.delete(positionId);

        for (const [symbol, ids] of this.positionsBySymbol) {
            if (ids.delete(positionId) && ids.size === 0) {
                this.positionsBySymbol.delete(symbol);
            }
        }
    }

    private indexSymbol(symbol: string, positionId: number): void {
        const existing = this.positionsBySymbol.get(symbol);

        if (existing === undefined) {
            this.positionsBySymbol.set(symbol, new Set([positionId]));

            return;
        }

        existing.add(positionId);
    }

    private symbolHasPosition(symbol: string, positionId: number): boolean {
        return this.positionsBySymbol.get(symbol)?.has(positionId) ?? false;
    }

    private parsePrice(raw: string): MoneyValue | null {
        try {
            const value = new Money(raw);

            if (value.isNaN() || !value.isFinite()) {
                return null;
            }

            return value;
        } catch {
            return null;
        }
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return cause.message;
        }

        return String(cause);
    }
}

import {
    CoinTierEnum,
    HaltSourceEnum,
    IMarketStressResumedEvent,
    IModelDivergenceEvent,
    IRiskHaltEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RejectReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MARKET_STRESS_RESUMED_EVENT, MODEL_DIVERGENCE_TRIGGERED_EVENT, RISK_HALT_TRIGGERED_EVENT } from '../../alert/const/alertEvents';

import { MS_PER_MINUTE } from '../../common/const';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { AppConfigService } from '../../config/service/AppConfigService';
import { CANDLE_INTERVAL_MS } from '../../strategy/const';
import { IProposedExit } from '../../strategy/interface';
import {
    AGG_TRADE_BUY_FLOW_BALANCE,
    COIN_DEPTH_FLOOR_10BPS_USDT,
    CONSECUTIVE_LOSS_HALT_COUNT,
    LIQUIDATION_SAFETY_BUFFER_FACTOR,
    MARKET_STRESS_MAX_DAILY_REHALT,
    MARKET_STRESS_RESUME_CLEAR_TICKS,
    MARKET_STRESS_RESUME_ELIGIBLE_LEG,
    MAX_LEVERAGE,
    RESERVATION_TTL_MS,
    TIER3_VALIDATED_VERSION_IDS,
    TIER_SPREAD_CEILING_PCT,
    WEEKLY_LOSS_WINDOW_DAYS,
} from '../const';
import { ReservationStateEnum } from '../enum';
import { IClosedPositionView, IExposureReservation, IOpenPositionView, IOrderIntent, IRiskDecision, IRiskGateContext, IRiskStateDay } from '../interface';
import { IPositionQuery, POSITION_QUERY } from '../../position/interface';
import { RiskStateRepository } from '../repository/RiskStateRepository';
import { ReservationLedger } from './ReservationLedger';
import { IOccupiedSlot, SlotAssignment, SlotManager } from './SlotManager';
import { StressHaltEvaluator } from './StressHaltEvaluator';

const MAX_LEVERAGE_DEC = new Money(MAX_LEVERAGE);

// M6 W4b (ADR 0010 §1c, §7). Telemetry event for case (c) qty drift. Engine-internal;
// M9 will hook this for alerting and the model-divergence counter (ADR 0004 §6).
export const EXPOSURE_DRIFT_RECORDED_EVENT = 'risk.exposure.driftRecorded';

// The state the gate loads ONCE per evaluate and threads down, so getDay/findOpen are not
// re-queried per check (the decision logic stays pure — it reads this snapshot, not the DB).
// `today` is mutable: on a breadth auto-resume (M23, ADR 0004 §6d) the gate flips isHalted/
// haltReason in-memory so later coins in the same tick do not re-enter the halted branch.
interface ILoadedState {
    today: IMutableRiskStateDay | null;
    readonly openPositions: IOpenPositionView[];
}

// Mutable view of the loaded day-row. The persisted row stays the source of truth; this is the
// per-evaluate working copy whose halt fields the auto-resume branch clears in place.
type IMutableRiskStateDay = { -readonly [Key in keyof IRiskStateDay]: IRiskStateDay[Key] };

// M27 observability-only. A failing-check verdict that carries the reject reason plus, for a
// market_stress halt, the classified halt leg (`haltReasonDetail`). Non-stress checks set
// `haltReasonDetail: null`. The orchestrator stamps decisions.halt_reason_detail from this.
interface IRejectVerdict {
    readonly reason: RejectReasonEnum;
    readonly haltReasonDetail: string | null;
}

// The central risk gate (ADR 0004 §1/§2). The single chokepoint: nothing reaches execution
// without passing it, and NO order action bypasses it. open/add run the full ordered check
// pipeline; reduce/close/flatten always approve but still route through (record decision,
// release reservation/exposure). Command-Query Separation: evaluate RETURNS a verdict and,
// only on approval, reserves on the in-memory ledger (§3). It writes no DB rows and emits no
// events — the orchestrator persists and emits.
@Injectable()
export class RiskGateService {
    private readonly logger = new Logger(RiskGateService.name);

    // M6 W8 (ADR 0014 §1, §9). The orchestrator is closed until phase 9 of the
    // boot pipeline flips this flag. Mid-recovery triggers reject with
    // RECOVERY_IN_PROGRESS — log-only (ADR §9: "do not write decisions rows
    // would pollute the trigger evidence base for M8"). The gate's `rejected`
    // helper logs at log-level rather than writing — matches the §9 rule.
    //
    // Starts FALSE: NestJS DI constructs the gate during module-init (phase 0),
    // well before the EngineBootstrapService runs phases 1–9 in its
    // OnApplicationBootstrap hook. `markRecoveryComplete()` is called by the
    // bootstrap service at phase 9.
    private recoveryReady = false;

    // M9 W6.1 — bus-emit transition guards. Both flags ensure the alert pipeline
    // hears the engage exactly once: market-stress mirrors `risk_state.isHalted`
    // (DB-canonical, replay-safe), so we only emit when the durable persistHalt
    // would actually write the flip — `state.today.isHalted === false`. Model-
    // divergence has no DB flag (the source signal is `context.modelDivergenceDetected`
    // recomputed each evaluate), so we keep an in-memory transition flag that
    // resets when the context signal clears — first re-engage after a clear
    // re-fires, repeated rejects while still detected do not.
    private divergenceEmitted = false;

    // M9 R2 fix — same-tick race guard for the stress emit. The pre-fix path
    // read `state.today.isHalted` from a snapshot loaded BEFORE `persistHalt`
    // ran, so two concurrent `evaluate(...)` calls in the same tick (Promise
    // scheduling) could BOTH observe `isHalted=false` and BOTH emit before
    // either persist landed. The UTC-day key here is the same idempotency
    // anchor `persistHalt` uses on the DB side — once we emit for today, we
    // do not re-emit until the UTC day rolls over (or the day key clears).
    // Reset semantics mirror `divergenceEmitted`: cleared by the day-rollover
    // path in `firstFailingHaltCheck` so the next UTC day's first engage
    // emits cleanly.
    private stressEmittedForDate: string | null = null;

    // M23 (ADR 0004 §6d) — breadth auto-resume in-memory state. All reset at UTC rollover; the
    // clean-tick counter also resets to 0 on any non-clean tick, NaN fail-closed, recurrence, or
    // restart. None is persisted (no migration; see ADR 0004 §6d restart quirk).
    private stressClearCount = 0; // consecutive clean global-breadth ticks in the inner band
    private stressReHaltCountForDate: string | null = null; // UTC day the re-halt counter belongs to
    private stressReHaltCount = 0; // breadth re-halts this UTC day; at the cap → full-day lock
    private autoResumeEmittedForDate: string | null = null; // dedup for the MARKET_STRESS_RESUMED emit

    constructor(
        private readonly ledger: ReservationLedger,
        private readonly slotManager: SlotManager,
        private readonly stress: StressHaltEvaluator,
        // M6 W4b seams (ADR 0010 §1b/§1c, §7). RiskStateRepository is in the same module
        // so direct injection is canonical (no port indirection needed for an internal
        // M6 mutation path). Position state arrives through the minimal `IPositionQuery`
        // port bound to the `POSITION_QUERY` token in PositionModule — this is the seam
        // that lets RiskModule depend on a token rather than `forwardRef(() => PositionModule)`
        // and lets the gate's constructor drop its `@Inject(forwardRef(...))` wrapper.
        // Surface is intentionally narrow: only `findById` (case-(b) reconcileClose +
        // case-(c) recordExposureDrift). Broader read access stays on the repository
        // and is consumed via `IOpenPositionsPort` from `RiskGateContext`.
        @Inject(POSITION_QUERY)
        private readonly positions: IPositionQuery,
        private readonly riskState: RiskStateRepository,
        private readonly events: EventEmitter2,
        // M23 (ADR 0004 §6d). Appended last so existing positional test instantiations keep
        // compiling; NestJS resolves constructor params by type, so position is irrelevant for DI.
        private readonly appConfig: AppConfigService,
    ) {}

    // M6 W8 (ADR 0014 §1, §9). Phase 9 of the boot pipeline opens the
    // orchestrator. Idempotent: safe to call from a re-run path (the flag is
    // monotonic — `recoveryReady` once true stays true for the process
    // lifetime; a kill-switch halt uses HaltFlagService, not this flag).
    markRecoveryComplete(): void {
        if (this.recoveryReady) {
            return;
        }

        this.recoveryReady = true;
        this.logger.warn('recovery complete — orchestrator open for triggers');
    }

    // M6 W8 read-API for tests + the bootstrap service.
    isRecoveryReady(): boolean {
        return this.recoveryReady;
    }

    // M6 W8 (ADR 0014 §4a). Phase 4a rebuild of `risk_state.open_exposure` from
    // `SUM(positions.entry_notional WHERE state in non-closed)` is the
    // authoritative release path for leaked reservations across a crash. The
    // bootstrap service computes the sum from a fresh DB read; this setter
    // persists it via the same upsert path the gate's mutation primitives use.
    //
    // Single atomic UPDATE on the day's risk_state row (ADR 0009 §6.1 invariant
    // applies to all DB-canonical state writes). The other columns
    // (realizedPnlDay, tradesCount, isHalted, haltReason) are preserved from
    // the loaded row — only openExposure is rebuilt.
    async setOpenExposureFromBoot(openExposure: MoneyValue, nowMs: number): Promise<void> {
        const utcDateString = new Date(nowMs).toISOString().slice(0, 10);
        const today = await this.riskState.findByDate(utcDateString);

        await this.riskState.upsertDay({
            date: utcDateString,
            realizedPnlDay: today?.realizedPnlDay ?? new Money(0),
            openExposure,
            tradesCount: today?.tradesCount ?? 0,
            isHalted: today?.isHalted ?? false,
            haltReason: today?.haltReason ?? null,
        });

        this.logger.warn(`boot exposure rebuild: open_exposure=${openExposure.toFixed()} (authoritative — pre-crash deltas ignored)`);
    }

    // M7 R1a fix-1 (security): `overrideLedger` lets the backtest pass its per-run
    // `ctx.reservationLedger` instead of mutating the DI singleton. Live callers pass
    // nothing → `this.ledger` is used as before. The override is threaded through every
    // private helper invoked synchronously from `evaluate` so a backtest cannot poison
    // live state via `listActive`/`reserve` reads.
    async evaluate(intent: IOrderIntent, context: IRiskGateContext, overrideLedger?: ReservationLedger): Promise<IRiskDecision> {
        const ledger = overrideLedger ?? this.ledger;
        // M6 R1.1.1 (ADR 0014 §1 revised). Mid-recovery RECOVERY_IN_PROGRESS reject
        // narrowed to OPENING intents only — `intentAction ∈ {OPEN, ADD}`. De-risking
        // intents (REDUCE / CLOSE / FLATTEN) MUST pass during recovery so:
        //   - case-(a) foreign-flatten policy can liquidate adopted positions at boot;
        //   - local-monitor SL/TP breach between phase 4c (re-arm) and phase 9 can
        //     still close the position via the gate-routed close path (ADR 0011 §4);
        //   - operator kill-switch FLATTEN reaches the executor even before phase 9.
        // Strategy-originated OPEN/ADD remain rejected — that's the original §1 intent
        // (no new trades during recovery).
        if (!this.recoveryReady && this.isOpening(intent.intentAction)) {
            return this.rejected(intent, RejectReasonEnum.RECOVERY_IN_PROGRESS);
        }

        if (this.isDeRisking(intent.intentAction)) {
            return this.approveDeRisking(intent);
        }

        return this.evaluateEntry(intent, context, ledger);
    }

    private isOpening(action: OrderIntentActionEnum): boolean {
        return action === OrderIntentActionEnum.OPEN || action === OrderIntentActionEnum.ADD;
    }

    // M6 seams (ADR 0004 §3): the reconciliation loop drives these.
    releaseReservation(reservationId: string): void {
        this.ledger.releaseReservation(reservationId);
    }

    confirmReservation(reservationId: string): void {
        this.ledger.confirmReservation(reservationId);
    }

    expireStaleReservations(nowMs: number): void {
        this.ledger.expireStaleReservations(nowMs);
    }

    // M6 W4b (ADR 0010 §1b, §7). Case (b) primitive: the position was closed outside the
    // bot (liquidation, manual close, exchange-side SL/TP, or a crash-window-lost fill).
    // No order is placed — the close already happened. We:
    //
    //   1. Best-effort release any in-flight reservation that matches the position's
    //      (symbol, slot). Per the dispatch + ADR 0010 §1f revised: no precise reservationId
    //      lookup exists today; the ledger's `(symbol, slot)` is the closest available key.
    //      No-op if nothing matches (idempotent on repeat calls).
    //   2. Decrement today's `risk_state.open_exposure` by the position's `entry_notional`.
    //      Single atomic upsert (matches the dual-write invariant for risk_state).
    //   3. Emit nothing here — ReconciliationService emits the resolved event around this
    //      call so the gate stays a pure mutation primitive.
    //
    // Idempotent: calling twice with the same positionId double-decrements only if the
    // second call also finds an active reservation (won't, the first call released it);
    // exposure decrement is also bounded — clamped to zero so a duplicate call cannot
    // drive open_exposure negative.
    async reconcileClose(positionId: number, nowMs: number): Promise<void> {
        const position = await this.positions.findById(positionId);

        if (position === null) {
            this.logger.warn(`reconcileClose positionId=${positionId} - position not found (no-op)`);

            return;
        }

        const released = this.releaseInFlightReservationFor(position.symbol, position.positionSlot);

        if (released !== null) {
            this.logger.log(`reconcileClose positionId=${positionId} released in-flight reservation ${released}`);
        }

        // M6 R1.1.4 (ADR 0010 §1b revised). Release the LIVE RESIDUAL notional, not
        // the historical `entry_notional`. After ADDs and partial REDUCEs, the
        // notional currently exposed is `position.qty * position.entryPrice` —
        // entry_notional captures the gross-at-open amount and would double-count
        // an add that already updated exposure at fill time. Decimal math; the
        // post-residual exposure is clamped at zero inside `adjustOpenExposure`.
        const residualNotional = position.qty.times(position.entryPrice);
        await this.adjustOpenExposure(residualNotional.negated(), nowMs, `reconcileClose:${positionId}`);

        this.logger.log(
            `reconcileClose positionId=${positionId} symbol=${position.symbol} - exposure -${residualNotional.toFixed()} ` +
                `(residual qty=${position.qty.toFixed()} * entryPrice=${position.entryPrice.toFixed()})`,
        );
    }

    // M6 W4b (ADR 0010 §1c, §7). Case (c) primitive: DB and exchange qty disagreed.
    // Adjusts `risk_state.open_exposure` by the notional delta `(exchangeQty - dbQty) * entryPrice`,
    // logs a structured WARN, and emits a divergence telemetry event so M9 alerts can fire
    // and the model-divergence counter (ADR 0004 §6) can advance. Pure mutation primitive;
    // ReconciliationService composes this with `PositionService.adjustQty` for the row-side
    // mutation.
    async recordExposureDrift(positionId: number, dbQty: MoneyValue, exchangeQty: MoneyValue, nowMs: number): Promise<void> {
        const position = await this.positions.findById(positionId);

        if (position === null) {
            this.logger.warn(`recordExposureDrift positionId=${positionId} - position not found (no-op)`);

            return;
        }

        const qtyDelta = exchangeQty.minus(dbQty);
        const notionalDelta = qtyDelta.times(position.entryPrice);

        this.logger.warn(
            `recordExposureDrift positionId=${positionId} symbol=${position.symbol} ` +
                `dbQty=${dbQty.toFixed()} exchangeQty=${exchangeQty.toFixed()} qtyDelta=${qtyDelta.toFixed()} ` +
                `notionalDelta=${notionalDelta.toFixed()}`,
        );

        await this.adjustOpenExposure(notionalDelta, nowMs, `recordExposureDrift:${positionId}`);

        // Telemetry event — engine-internal so a future M9 alerting consumer + a model-
        // divergence counter (ADR 0004 §6) can subscribe. The payload is intentionally
        // minimal; W5+ may upgrade to a shared contract event.
        this.events.emit(EXPOSURE_DRIFT_RECORDED_EVENT, {
            positionId,
            symbol: position.symbol,
            dbQty: dbQty.toFixed(),
            exchangeQty: exchangeQty.toFixed(),
            notionalDelta: notionalDelta.toFixed(),
            recordedAtMs: nowMs,
        });
    }

    // M6 R1.1.5 (ADR 0010 §7 revised, ADR 0004 §3/§7). Matcher key tightened to
    // `(eventId, slot)` when an eventId is supplied. The reservationId encodes
    // `${eventId}:${slot}` (gate-minted deterministic seed, see `buildReservation`)
    // so we extract eventId from the reservationId without needing a separate
    // ledger field. When eventId is null/undefined (caller doesn't know it —
    // e.g., case-(b) reconcileClose where the position row has no persisted
    // eventId), fall back to the historical `(symbol, slot)` match. The fallback
    // is a best-effort no-op-or-release; the precise eventId path is the one M8
    // analytics + future case-(f) precise-release callers use to disambiguate
    // two coexisting reservations on the same `(symbol, slot)`.
    //
    // M6 R2.1.2 (documentation-only). The precise-match branch
    // (`eventId !== null/undefined` → reservationId equality check) is reachable
    // from tests today but dormant from production callers: no live caller
    // currently passes `eventId` because `positions` does not persist
    // `triggering_event_id`. ADR-0010 §7 names M7 W0 as the wave that adds the
    // `eventId` column + the case-(f) precise-release call site; until then
    // every production invocation walks the `(symbol, slot)` fallback path.
    private releaseInFlightReservationFor(symbol: string, slot: PositionSlotEnum | null | undefined, eventId?: string | null): string | null {
        if (slot === null || slot === undefined) {
            return null;
        }

        const match = this.ledger.listActive().find((reservation) => {
            if (reservation.symbol !== symbol || reservation.slot !== slot) {
                return false;
            }

            if (eventId === null || eventId === undefined) {
                return true; // fallback path — first (symbol, slot) hit wins
            }

            // Precise match: reservationId is `${eventId}:${slot}`; compare the prefix.
            return reservation.reservationId === `${eventId}:${slot}`;
        });

        if (match === undefined) {
            return null;
        }

        this.ledger.releaseReservation(match.reservationId);

        return match.reservationId;
    }

    // Read-modify-write the day's `risk_state` row. The upsert is idempotent on the date
    // key (ADR 0004 §5/§7). `delta` is signed: positive on add, negative on close.
    // Clamps openExposure at zero so a duplicate reconcileClose can't drive it negative.
    private async adjustOpenExposure(delta: MoneyValue, nowMs: number, reason: string): Promise<void> {
        const utcDateString = new Date(nowMs).toISOString().slice(0, 10);
        const today = await this.riskState.findByDate(utcDateString);
        const current = today?.openExposure ?? new Money(0);
        const nextRaw = current.plus(delta);
        const next = nextRaw.lessThan(0) ? new Money(0) : nextRaw;

        if (nextRaw.lessThan(0)) {
            this.logger.warn(
                `open_exposure adjustment ${reason} would have driven exposure negative (current=${current.toFixed()}, delta=${delta.toFixed()}); clamped to 0`,
            );
        }

        await this.riskState.upsertDay({
            date: utcDateString,
            realizedPnlDay: today?.realizedPnlDay ?? new Money(0),
            openExposure: next,
            tradesCount: today?.tradesCount ?? 0,
            isHalted: today?.isHalted ?? false,
            haltReason: today?.haltReason ?? null,
        });
    }

    private isDeRisking(action: OrderIntentActionEnum): boolean {
        return action === OrderIntentActionEnum.REDUCE || action === OrderIntentActionEnum.CLOSE || action === OrderIntentActionEnum.FLATTEN;
    }

    // reduce/close/flatten can never be blocked (§2). They still route through so the action
    // is recorded and the reservation/exposure is released for the closed notional.
    private approveDeRisking(intent: IOrderIntent): IRiskDecision {
        this.logger.log(`de-risk ${intent.intentAction} ${intent.symbol} approved (gate pass-through)`);

        return {
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            approvedSlot: null,
            approvedSizing: intent.sizing,
            clampedExit: intent.proposedExit,
            reservationId: null,
            haltReasonDetail: null,
        };
    }

    // The ordered check pipeline for open/add (ADR 0004 §2). The first failing check
    // short-circuits and returns its RejectReasonEnum. Order is fixed for replay determinism.
    private async evaluateEntry(intent: IOrderIntent, context: IRiskGateContext, ledger: ReservationLedger): Promise<IRiskDecision> {
        const state = await this.loadState(context);

        const reject = await this.firstFailingCheck(intent, context, state, ledger);

        if (reject !== null) {
            return this.rejected(intent, reject.reason, reject.haltReasonDetail);
        }

        const slot = this.assignSlot(intent, context, state, ledger);

        if (slot.kind === 'rejected') {
            return this.rejected(intent, slot.reason);
        }

        const clampedExit = this.clampStopInsideLiquidation(intent);

        if (clampedExit === null) {
            return this.rejected(intent, RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        }

        return this.reserveAndApprove(intent, context, state, slot.slot, clampedExit, ledger);
    }

    // Load the durable state ONCE (MEDIUM: no repeated getDay/findOpen per evaluate).
    private async loadState(context: IRiskGateContext): Promise<ILoadedState> {
        const [today, openPositions] = await Promise.all([context.riskState.getDay(context.utcDateString), context.openPositions.findOpen()]);

        // Copy the loaded row into a mutable working view so the M23 auto-resume branch can clear
        // the day-halt in-memory for the rest of the tick without aliasing the port's snapshot.
        return { today: today === null ? null : { ...today }, openPositions };
    }

    private async firstFailingCheck(
        intent: IOrderIntent,
        context: IRiskGateContext,
        state: ILoadedState,
        ledger: ReservationLedger,
    ): Promise<IRejectVerdict | null> {
        const haltVerdict = await this.firstFailingHaltCheck(context, state);

        if (haltVerdict !== null) {
            return haltVerdict;
        }

        const tierReason = this.firstFailingTierFilter(intent, context);

        if (tierReason !== null) {
            return this.withoutHaltDetail(tierReason);
        }

        const statefulReason = await this.checkStatefulLimits(intent, context, state, ledger);

        return statefulReason === null ? null : this.withoutHaltDetail(statefulReason);
    }

    // M27 observability-only. Wrap a non-halt reject reason as a verdict with no halt-leg detail.
    private withoutHaltDetail(reason: RejectReasonEnum): IRejectVerdict {
        return { reason, haltReasonDetail: null };
    }

    // Global-halt + stress filters. A fresh stress verdict is recorded DURABLY on risk_state
    // (is_halted=true, halt_reason='market_stress') so the GLOBAL_HALT re-entry block and M9
    // (Telegram) both see it; the upsert is idempotent on the UTC-day key (replay-safe).
    private async firstFailingHaltCheck(context: IRiskGateContext, state: ILoadedState): Promise<IRejectVerdict | null> {
        if (!Number.isFinite(context.nowMs)) {
            return this.withoutHaltDetail(RejectReasonEnum.GLOBAL_HALT);
        }

        // M9 R2 — UTC-day rollover reset for the stress dedup flag. Mirrors
        // the divergenceEmitted reset pattern (cleared when the source signal
        // changes). The dedup is per UTC day so a fresh day re-arms the emit.
        if (this.stressEmittedForDate !== null && this.stressEmittedForDate !== context.utcDateString) {
            this.stressEmittedForDate = null;
        }

        // M23 (ADR 0004 §6d) — UTC-day rollover reset for the auto-resume counters. A fresh day
        // re-arms the clean-tick counter, the per-day re-halt cap, and the resume-emit dedup.
        if (this.stressReHaltCountForDate !== context.utcDateString) {
            this.stressReHaltCountForDate = context.utcDateString;
            this.stressReHaltCount = 0;
            this.stressClearCount = 0;
            this.autoResumeEmittedForDate = null;
        }

        if (context.modelDivergenceDetected) {
            this.emitModelDivergenceOnce(context);

            return this.withoutHaltDetail(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        }

        // M9 W6.1 — context signal cleared; reset the transition flag so the
        // next re-engage fires a fresh alert event.
        this.divergenceEmitted = false;

        if (state.today !== null && state.today.isHalted) {
            const dayHaltVerdict = await this.resolveDayHalt(context, state);

            if (dayHaltVerdict !== null) {
                return dayHaltVerdict;
            }
        }

        if (this.stress.isStressed(context.snapshot, context.params, this.appConfig.paperRelaxMarketStress)) {
            // M9 W6.1 — emit BEFORE persistHalt so the engage transition is
            // gated by the same "not yet halted today" predicate persistHalt
            // uses internally. Re-evaluations later in the day find
            // state.today.isHalted === true and skip both the persist and the
            // bus emit (idempotent on the UTC-day key).
            this.emitMarketStressIfTransitioning(context, state);
            await this.persistHalt(context, state, RejectReasonEnum.MARKET_STRESS);

            // M23 (ADR 0004 §6d) — advance the per-day breadth re-halt counter and reset the
            // clean-tick counter ONLY for a market_stress halt. Kept at the call site (not inside
            // persistHalt) so the command stays a pure DB write + flag set (CQS). persistHalt is
            // idempotent on an already-halted day, so a re-evaluation that skips the write must not
            // re-advance the counter — guard on the same not-yet-halted predicate persistHalt uses.
            if (!(state.today !== null && state.today.isHalted)) {
                this.stressReHaltCount++;
                this.stressClearCount = 0;
            }

            // M27 — the detail is the SAME string persistHalt wrote to risk_state.halt_reason
            // (market_stress:<leg>), so the decision row and the day-row agree verbatim.
            return { reason: RejectReasonEnum.MARKET_STRESS, haltReasonDetail: this.buildPersistedHaltReason(context, RejectReasonEnum.MARKET_STRESS) };
        }

        return null;
    }

    // M23 (ADR 0004 §6d) — day-halt resolution for an already-halted day. Returns the reject
    // reason to short-circuit on, or null when a breadth halt auto-resumed (the caller then falls
    // through to the fresh isStressed() engage check so a same-tick re-stress can re-halt). The
    // branch runs BEFORE the legacy day-lock early return: every non-breadth stress leg, every
    // loss-based reason, a hit re-halt cap, or a disabled flag all keep the full-day lock.
    private async resolveDayHalt(context: IRiskGateContext, state: ILoadedState): Promise<IRejectVerdict | null> {
        const day = state.today;

        if (day === null) {
            return null;
        }

        // M27 — an already-halted-day reject carries the persisted halt_reason verbatim
        // (the day-row is the source of truth here; the gate does NOT re-classify the leg).
        const dayHaltVerdict: IRejectVerdict = { reason: RejectReasonEnum.GLOBAL_HALT, haltReasonDetail: day.haltReason };

        if (!this.isBreadthAutoResumeEligible(day.haltReason)) {
            return dayHaltVerdict;
        }

        if (this.stressReHaltCount >= MARKET_STRESS_MAX_DAILY_REHALT) {
            return dayHaltVerdict;
        }

        if (this.stress.isGlobalStressed(context.snapshot)) {
            this.stressClearCount = 0;

            return dayHaltVerdict;
        }

        this.stressClearCount++;

        if (this.stressClearCount < MARKET_STRESS_RESUME_CLEAR_TICKS) {
            return dayHaltVerdict;
        }

        await this.autoResumeMarketStress(context, day);

        return null;
    }

    // Only a breadth-SOLE market_stress halt auto-resumes (ADR 0004 §6d). The reason carries the
    // canonical `market_stress:breadth` suffix; every other suffix (`:multi`, non-breadth legs,
    // `:same_bar`, `:invalid`), a bare legacy `market_stress`, and every loss-based reason are not
    // eligible. The whole branch is gated by the boot flag (paper-on, live-off).
    private isBreadthAutoResumeEligible(haltReason: string | null): boolean {
        if (!this.appConfig.marketStressAutoResumeEnabled) {
            return false;
        }

        return haltReason === `${RejectReasonEnum.MARKET_STRESS}:${MARKET_STRESS_RESUME_ELIGIBLE_LEG}`;
    }

    // M23 (ADR 0004 §6d). Clear the persisted day-halt (preserving the PnL/exposure/trade
    // counters), drop the in-memory flag, reset the clean-tick counter, re-arm the stress-emit
    // dedup so a same-day re-halt still fires a fresh RISK_HALT_TRIGGERED (review M1), and emit
    // MARKET_STRESS_RESUMED once per resume per UTC day. The caller flips the in-memory day row
    // so later coins in the same tick do not re-enter the halted branch.
    private async autoResumeMarketStress(context: IRiskGateContext, mutableDay: IMutableRiskStateDay): Promise<void> {
        await context.riskState.clearHaltForDate(context.utcDateString);

        mutableDay.isHalted = false;
        mutableDay.haltReason = null;

        this.stressClearCount = 0;
        this.stressEmittedForDate = null;

        this.logger.warn(
            `market_stress auto-resumed leg=${MARKET_STRESS_RESUME_ELIGIBLE_LEG} breadth=${context.snapshot.market_breadth_5m_up_pct} reHalts=${this.stressReHaltCount}`,
        );

        if (this.autoResumeEmittedForDate === context.utcDateString) {
            return;
        }

        this.autoResumeEmittedForDate = context.utcDateString;

        const payload: IMarketStressResumedEvent = {
            triggerLeg: MARKET_STRESS_RESUME_ELIGIBLE_LEG,
            clearCount: MARKET_STRESS_RESUME_CLEAR_TICKS,
            breadthAtResume: context.snapshot.market_breadth_5m_up_pct,
            dailyReHaltCount: this.stressReHaltCount,
            utcDateString: context.utcDateString,
            nearReHaltCap: this.stressReHaltCount + 1 >= MARKET_STRESS_MAX_DAILY_REHALT,
        };

        this.events.emit(MARKET_STRESS_RESUMED_EVENT, payload);
    }

    // M9 W6.1 — bus-emit on the engage transition for market-stress halt. The
    // payload mirrors the existing reject reason vocabulary and stringifies the
    // cheap, already-available snapshot metrics that drove the stress verdict.
    // Read-only side-channel: never touches the gate's reject/accept decision.
    private emitMarketStressIfTransitioning(context: IRiskGateContext, state: ILoadedState): void {
        if (state.today !== null && state.today.isHalted) {
            return;
        }

        // M9 R2 — same-tick race guard. Two concurrent evaluate() calls can
        // both observe state.today.isHalted===false before either persistHalt
        // commits; the in-memory flag closes that window without changing the
        // accept/reject decision path.
        if (this.stressEmittedForDate === context.utcDateString) {
            return;
        }

        this.stressEmittedForDate = context.utcDateString;

        const payload: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: this.stress.classifyHaltLeg(context.snapshot, context.params, this.appConfig.paperRelaxMarketStress),
            engagedAt: new Date(context.nowMs).toISOString(),
            metrics: {
                oiChange5mPct: String(context.snapshot.open_interest_change_5m_pct),
                fundingRate: String(context.snapshot.funding_rate),
                spreadPct: String(context.snapshot.bid_ask_spread_pct),
            },
        };

        this.events.emit(RISK_HALT_TRIGGERED_EVENT, payload);
    }

    // M9 W6.1 — bus-emit on the engage transition for model-divergence kill
    // switch. The reject path stays byte-identical; emit is a read-only
    // side-channel. Transition is tracked in-memory because the source signal
    // is a recomputed context boolean, not a DB flag.
    private emitModelDivergenceOnce(context: IRiskGateContext): void {
        if (this.divergenceEmitted) {
            return;
        }

        this.divergenceEmitted = true;

        // TODO M11: surface modeled-vs-observed slippage gap. The current
        // context only carries the boolean `modelDivergenceDetected`; the
        // numeric figures live in the M11 divergence detector. Until that
        // surfaces them on IRiskGateContext, the payload reports `null` per
        // ADR 0022 §2.3.1 — divide-by-zero on a zero-sample window is not
        // "0 bps" of slippage, it is "unknown".
        const payload: IModelDivergenceEvent = {
            engagedAt: new Date(context.nowMs).toISOString(),
            reason: RejectReasonEnum.MODEL_DIVERGENCE_HALT,
            observedSlippageBps: null,
            modeledSlippageBps: null,
            sampleCount: 0,
        };

        this.events.emit(MODEL_DIVERGENCE_TRIGGERED_EVENT, payload);
    }

    private firstFailingTierFilter(intent: IOrderIntent, context: IRiskGateContext): RejectReasonEnum | null {
        if (context.belowUniverseFloor) {
            return RejectReasonEnum.BELOW_UNIVERSE_FLOOR;
        }

        if (this.isOiUnavailable(context)) {
            return RejectReasonEnum.OI_UNAVAILABLE;
        }

        if (this.isSpreadTooWide(intent, context)) {
            return RejectReasonEnum.SPREAD_TOO_WIDE;
        }

        if (this.isBookTooThin(intent, context)) {
            return RejectReasonEnum.COIN_BOOK_TOO_THIN;
        }

        if (this.isTier3Unvalidated(intent, context)) {
            return RejectReasonEnum.TIER3_NOT_VALIDATED;
        }

        return null;
    }

    private async checkStatefulLimits(
        intent: IOrderIntent,
        context: IRiskGateContext,
        state: ILoadedState,
        ledger: ReservationLedger,
    ): Promise<RejectReasonEnum | null> {
        if (await this.isCooldownActive(intent, context)) {
            return RejectReasonEnum.COOLDOWN_ACTIVE;
        }

        const lossWindowReason = await this.checkLossWindows(context, state);

        if (lossWindowReason !== null) {
            return lossWindowReason;
        }

        const overtradingReason = await this.checkOvertradingCaps(intent, context, ledger);

        if (overtradingReason !== null) {
            return overtradingReason;
        }

        return this.checkFundingFlowSkip(intent, context);
    }

    private isOiUnavailable(context: IRiskGateContext): boolean {
        const oiMissing = context.snapshot.open_interest === null || context.snapshot.open_interest === undefined;

        return context.params.require_oi_available && oiMissing;
    }

    // Independently fail-closed against NaN/Infinity (don't rely on the stress evaluator's
    // earlier input guard — pipeline-order coupling is fragile if a future check re-orders).
    private isSpreadTooWide(intent: IOrderIntent, context: IRiskGateContext): boolean {
        const spread = context.snapshot.bid_ask_spread_pct;

        if (!Number.isFinite(spread)) {
            return true;
        }

        const ceiling = TIER_SPREAD_CEILING_PCT[intent.coinTier];

        return spread > ceiling;
    }

    // Per-coin book-depth eligibility guard (ADR 0004 §6a). Depth AT or below the tier floor is
    // too thin => coin_book_too_thin (a per-coin SKIP, never a halt — it runs after the halt
    // checks). Fail-closed like isSpreadTooWide: an unknown tier, or missing/empty/unparseable/
    // non-finite/non-positive depth, all resolve to too-thin so bad data costs a single skip,
    // never a fill. book_depth_10bps_usdt crosses the shared boundary as a decimal string;
    // parse it ONCE through the typed parseMoney helper inside a try/catch (whitespace/garbage
    // throws MoneyParseException, caught here) and validate on the Decimal itself (.isFinite()
    // catches 'NaN'/'Infinity', which decimal.js parses without throwing) so a malformed string
    // can NEVER throw out of the gate. Boundary is <= (depth exactly at the floor rejects),
    // opposite the spread's strict >.
    private isBookTooThin(intent: IOrderIntent, context: IRiskGateContext): boolean {
        const floor = COIN_DEPTH_FLOOR_10BPS_USDT[intent.coinTier];

        if (floor === undefined) {
            return true;
        }

        const depthRaw = context.snapshot.book_depth_10bps_usdt;

        if (depthRaw === null || depthRaw === undefined || depthRaw === '') {
            return true;
        }

        let depth: MoneyValue;

        try {
            depth = parseMoney(depthRaw);
        } catch {
            return true;
        }

        if (!depth.isFinite() || depth.lessThanOrEqualTo(0)) {
            return true;
        }

        return depth.lessThanOrEqualTo(new Money(floor));
    }

    private isTier3Unvalidated(intent: IOrderIntent, context: IRiskGateContext): boolean {
        const isTier3 = intent.coinTier === CoinTierEnum.TIER_3;
        const isValidated = TIER3_VALIDATED_VERSION_IDS.includes(context.strategyVersionId);

        return isTier3 && !isValidated;
    }

    private async isCooldownActive(intent: IOrderIntent, context: IRiskGateContext): Promise<boolean> {
        const lastClose = await context.openPositions.findLastCloseForSymbol(intent.symbol);

        if (lastClose === null || !lastClose.realizedPnl.isNegative()) {
            return false;
        }

        return context.nowMs - lastClose.closedAtMs < context.limits.cooldownAfterLossMs;
    }

    private async checkLossWindows(context: IRiskGateContext, state: ILoadedState): Promise<RejectReasonEnum | null> {
        const dailyPnl = state.today?.realizedPnlDay ?? new Money(0);

        if (dailyPnl.lessThanOrEqualTo(context.limits.dailyLossLimitUsdt.negated())) {
            return RejectReasonEnum.DAILY_LOSS_LIMIT;
        }

        const weeklyPnl = await context.riskState.sumRealizedPnlBetween(
            this.utcDateMinusDays(context.utcDateString, WEEKLY_LOSS_WINDOW_DAYS - 1),
            context.utcDateString,
        );

        if (weeklyPnl.lessThanOrEqualTo(context.limits.weeklyLossLimitUsdt.negated())) {
            return RejectReasonEnum.WEEKLY_LOSS_LIMIT;
        }

        if (await this.isConsecutiveLossHalt(context)) {
            await this.persistHalt(context, state, RejectReasonEnum.CONSECUTIVE_LOSS_HALT);

            return RejectReasonEnum.CONSECUTIVE_LOSS_HALT;
        }

        return null;
    }

    // Durable, idempotent halt write (ADR 0004 §6). Upserts today's risk_state row with
    // is_halted=true + the halt reason, preserving the existing PnL/exposure/trade counters.
    // Idempotent on the UTC-day key so a replay or a re-trigger never double-applies. For a
    // market_stress halt the written reason carries the `market_stress:<leg>` suffix (M23, ADR
    // 0004 §6d); loss-based reasons are written unchanged. Pure command: the per-day breadth
    // re-halt counters are advanced by the market_stress call site, not here (CQS).
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

        const leg = this.stress.classifyHaltLeg(context.snapshot, context.params, this.appConfig.paperRelaxMarketStress);

        return `${RejectReasonEnum.MARKET_STRESS}:${leg}`;
    }

    private emptyDay(dateString: string): IRiskStateDay {
        return {
            date: dateString,
            realizedPnlDay: new Money(0),
            openExposure: new Money(0),
            tradesCount: 0,
            isHalted: false,
            haltReason: null,
        };
    }

    // Consecutive closed losses today, derived from closed positions ordered by closedAt
    // (ADR 0004 §5) — not a stored column. A win resets the streak.
    private async isConsecutiveLossHalt(context: IRiskGateContext): Promise<boolean> {
        const closed = await context.openPositions.findClosedOnUtcDay(context.utcDateString);
        const ordered = [...closed].sort((left, right) => left.closedAtMs - right.closedAtMs);

        return this.longestTrailingLossStreak(ordered) >= CONSECUTIVE_LOSS_HALT_COUNT;
    }

    private longestTrailingLossStreak(ordered: IClosedPositionView[]): number {
        let streak = 0;

        for (const position of ordered) {
            if (position.realizedPnl.isNegative()) {
                streak += 1;
            } else {
                streak = 0;
            }
        }

        return streak;
    }

    // Overtrading caps (ADR 0004 § Overtrading). Per-symbol/day counts entries opened today;
    // per-bar-universe counts entries already CLAIMED in the current 5m bar window via the
    // in-memory ledger (createdAtMs in [barOpen, barOpen+interval)), NOT the never-incremented
    // daily risk_state.tradesCount — that counter is a daily total and would never fire per bar.
    private async checkOvertradingCaps(intent: IOrderIntent, context: IRiskGateContext, ledger: ReservationLedger): Promise<RejectReasonEnum | null> {
        const perSymbolToday = await context.openPositions.countOpenedOnUtcDayForSymbol(intent.symbol, context.utcDateString);

        if (perSymbolToday >= context.params.max_trades_per_symbol_per_day) {
            return RejectReasonEnum.MAX_TRADES_PER_SYMBOL_PER_DAY;
        }

        if (this.barWindowReservationCount(context.nowMs, ledger) >= context.params.max_trades_per_bar_universe) {
            return RejectReasonEnum.MAX_TRADES_PER_BAR_UNIVERSE;
        }

        return null;
    }

    // Bar-index match (NOT a `[barOpen, nowMs)` window). Every reservation in one bar shares
    // createdAtMs === context.nowMs (the deterministic bar-close clock), so a `< nowMs` upper
    // bound would exclude same-bar siblings and the per-bar cap would never fire in live.
    private barWindowReservationCount(nowMs: number, ledger: ReservationLedger): number {
        const currentBarIndex = Math.floor(nowMs / CANDLE_INTERVAL_MS);

        return ledger.listActive().filter((reservation) => Math.floor(reservation.createdAtMs / CANDLE_INTERVAL_MS) === currentBarIndex).length;
    }

    // Funding-as-skip flow rules (ADR 0004 §6 / brief line 52). All three guarded:
    //  (a) rising OI + funding-not-extreme on a FADE candidate => skip (trend may still run).
    //      Guarded to fades only — never rejects a momentum/follow entry.
    //  (b) deeply negative funding + rising price (short squeeze) on a SHORT => skip.
    //  (c) OI FALLING on the spike (liquidation cascade) => the valid reversion case (no skip).
    // Rising price is sourced from buy-flow dominance (agg_trade_buy_volume_ratio), a momentum
    // proxy, NOT the VWAP deviation level ("above VWAP" is a level, not a direction).
    private checkFundingFlowSkip(intent: IOrderIntent, context: IRiskGateContext): RejectReasonEnum | null {
        const oiRising = context.snapshot.open_interest_change_5m_pct > 0;
        const fundingExtreme = Math.abs(context.snapshot.funding_rate) >= context.params.funding_rate_suppress_threshold;

        if (this.isFadeEntry(intent, context) && oiRising && !fundingExtreme && context.params.oi_rising_skip) {
            return RejectReasonEnum.FUNDING_SUPPRESSED;
        }

        if (this.isShortSqueezeSkip(intent, context, fundingExtreme)) {
            return RejectReasonEnum.FUNDING_SUPPRESSED;
        }

        return null;
    }

    // A fade trades AGAINST the deviation: price spiked above VWAP and we go short, or it
    // dumped below and we go long (mean-reversion). vwap_deviation_pct sign carries the side.
    private isFadeEntry(intent: IOrderIntent, context: IRiskGateContext): boolean {
        const deviationAbove = context.snapshot.vwap_deviation_pct > 0;

        if (deviationAbove) {
            return intent.tradeSide === PositionSideEnum.SHORT;
        }

        return intent.tradeSide === PositionSideEnum.LONG;
    }

    private isShortSqueezeSkip(intent: IOrderIntent, context: IRiskGateContext, fundingExtreme: boolean): boolean {
        const deeplyNegativeFunding = context.snapshot.funding_rate < 0 && fundingExtreme;
        const risingPrice = context.snapshot.agg_trade_buy_volume_ratio > AGG_TRADE_BUY_FLOW_BALANCE;

        return intent.tradeSide === PositionSideEnum.SHORT && deeplyNegativeFunding && risingPrice;
    }

    private assignSlot(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState, ledger: ReservationLedger): SlotAssignment {
        const occupied = this.occupiedSlots(state, ledger);

        return this.slotManager.assign(intent.correlationMode, intent.idiosyncrasyScore, context.params.idiosyncrasy_min_score, occupied);
    }

    private occupiedSlots(state: ILoadedState, ledger: ReservationLedger): IOccupiedSlot[] {
        const fromPositions: IOccupiedSlot[] = state.openPositions
            .filter((position) => position.slot !== null)
            .map((position) => ({ slot: position.slot as PositionSlotEnum, correlationMode: position.correlationMode }));

        const fromReservations: IOccupiedSlot[] = ledger.listActive().map((reservation) => ({
            slot: reservation.slot,
            correlationMode: reservation.correlationMode,
        }));

        return [...fromPositions, ...fromReservations];
    }

    // SL-inside-liquidation validation (ADR 0004 §8). On isolated futures the liquidation
    // price is reached at the MAINTENANCE margin, not at zero initial margin, so the distance
    // is entryPrice x (1/leverage - maintenanceMarginRate). The stop must trigger inside a
    // safety-buffered fraction of that (room for worst-case adverse move + funding drag). If
    // the proposed stop is already inside it passes; else it is tightened; if the buffered
    // distance is non-positive (over-levered / maint margin exceeds initial), the gate rejects.
    private clampStopInsideLiquidation(intent: IOrderIntent): IProposedExit | null {
        const leverage = intent.sizing.leverage;

        if (leverage.lessThanOrEqualTo(0) || leverage.greaterThan(MAX_LEVERAGE_DEC)) {
            return null;
        }

        const liquidationFraction = new Money(1).dividedBy(leverage).minus(intent.maintenanceMarginRate);

        if (liquidationFraction.lessThanOrEqualTo(0)) {
            return null;
        }

        const liquidationDistance = intent.entryPrice.times(liquidationFraction);
        const safeDistance = liquidationDistance.times(LIQUIDATION_SAFETY_BUFFER_FACTOR);

        if (safeDistance.lessThanOrEqualTo(0)) {
            return null;
        }

        if (this.isWrongSideStop(intent)) {
            return null;
        }

        const stopDistance = intent.entryPrice.minus(intent.proposedExit.stopLossPrice).abs();

        if (stopDistance.lessThanOrEqualTo(safeDistance)) {
            return intent.proposedExit;
        }

        return this.tightenStop(intent, safeDistance);
    }

    // A LONG's protective stop must sit BELOW entry; a SHORT's ABOVE. A wrong-side stop is
    // never protective (it would never trigger before liquidation) — reject rather than clamp.
    private isWrongSideStop(intent: IOrderIntent): boolean {
        const stop = intent.proposedExit.stopLossPrice;
        const isLong = intent.tradeSide === PositionSideEnum.LONG;

        if (isLong) {
            return stop.greaterThanOrEqualTo(intent.entryPrice);
        }

        return stop.lessThanOrEqualTo(intent.entryPrice);
    }

    private tightenStop(intent: IOrderIntent, safeDistance: MoneyValue): IProposedExit {
        const tightened = intent.tradeSide === PositionSideEnum.LONG ? intent.entryPrice.minus(safeDistance) : intent.entryPrice.plus(safeDistance);

        return { ...intent.proposedExit, stopLossPrice: tightened };
    }

    private async reserveAndApprove(
        intent: IOrderIntent,
        context: IRiskGateContext,
        state: ILoadedState,
        slot: PositionSlotEnum,
        clampedExit: IProposedExit,
        ledger: ReservationLedger,
    ): Promise<IRiskDecision> {
        const exposureReason = this.checkExposureCaps(intent, context, state, ledger);

        if (exposureReason !== null) {
            return this.rejected(intent, exposureReason);
        }

        const timeStopReason = this.checkTimeStop(intent, context);

        if (timeStopReason !== null) {
            return this.rejected(intent, timeStopReason);
        }

        const reservation = this.buildReservation(intent, context, slot);
        ledger.reserve(reservation);

        this.logger.debug(
            `APPROVED ${intent.intentAction} ${intent.symbol} slot=${slot} qty=${intent.sizing.qty.toFixed()} ` +
                `notional=${intent.sizing.notional.toFixed()} lev=${intent.sizing.leverage.toFixed(2)} risk=${intent.sizing.riskPerTradeUsdt.toFixed()} ` +
                `resv=${reservation.reservationId}`,
        );
        this.logger.log(`APPROVED ${intent.intentAction} ${intent.symbol} slot=${slot}`);

        return {
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            approvedSlot: slot,
            approvedSizing: intent.sizing,
            clampedExit,
            reservationId: reservation.reservationId,
            haltReasonDetail: null,
        };
    }

    private checkExposureCaps(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState, ledger: ReservationLedger): RejectReasonEnum | null {
        const active = ledger.listActive();

        const perCoin = this.sumNotionalForSymbol(state.openPositions, active, intent.symbol).plus(intent.sizing.notional);

        if (perCoin.greaterThan(context.limits.maxExposurePerCoinUsdt)) {
            return RejectReasonEnum.EXPOSURE_CAP_PER_COIN;
        }

        const sameDirection = this.sumNotionalForSide(state.openPositions, active, intent.tradeSide).plus(intent.sizing.notional);

        if (sameDirection.greaterThan(context.limits.maxSameDirectionExposureUsdt)) {
            return RejectReasonEnum.SAME_DIRECTION_EXPOSURE_CAP;
        }

        return null;
    }

    private sumNotionalForSymbol(open: IOpenPositionView[], active: IExposureReservation[], symbol: string): MoneyValue {
        const fromOpen = open.filter((position) => position.symbol === symbol).reduce((sum, position) => sum.plus(position.notional), new Money(0));

        return active.filter((reservation) => reservation.symbol === symbol).reduce((sum, reservation) => sum.plus(reservation.notional), fromOpen);
    }

    private sumNotionalForSide(open: IOpenPositionView[], active: IExposureReservation[], side: PositionSideEnum): MoneyValue {
        const fromOpen = open.filter((position) => position.side === side).reduce((sum, position) => sum.plus(position.notional), new Money(0));

        return active.filter((reservation) => reservation.tradeSide === side).reduce((sum, reservation) => sum.plus(reservation.notional), fromOpen);
    }

    // Time-stop is MANDATORY for mean-reversion (ADR 0004 §8 / brief). Reject if missing or if
    // it exceeds params.time_stop_minutes from now.
    private checkTimeStop(intent: IOrderIntent, context: IRiskGateContext): RejectReasonEnum | null {
        const timeStopAtMs = intent.proposedExit.timeStopAtMs;

        if (timeStopAtMs === null || timeStopAtMs === undefined || !Number.isFinite(timeStopAtMs)) {
            return RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID;
        }

        const maxAllowedMs = context.nowMs + context.params.time_stop_minutes * MS_PER_MINUTE;

        if (timeStopAtMs <= context.nowMs || timeStopAtMs > maxAllowedMs) {
            return RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID;
        }

        return null;
    }

    private buildReservation(intent: IOrderIntent, context: IRiskGateContext, slot: PositionSlotEnum): IExposureReservation {
        return {
            reservationId: `${intent.eventId}:${slot}`,
            symbol: intent.symbol,
            slot,
            tradeSide: intent.tradeSide,
            notional: intent.sizing.notional,
            correlationMode: intent.correlationMode,
            createdAtMs: context.nowMs,
            expiresAtMs: context.nowMs + RESERVATION_TTL_MS,
            state: ReservationStateEnum.PENDING,
        };
    }

    // M27 observability-only. `haltReasonDetail` is the classified market_stress leg string
    // (verbatim copy of what the gate persists / read back from risk_state); null for every
    // non-stress reject. It rides on the verdict so the orchestrator stamps the decision row
    // without re-deriving the leg. The accept/reject decision is unchanged.
    private rejected(intent: IOrderIntent, reason: RejectReasonEnum, haltReasonDetail: string | null = null): IRiskDecision {
        this.logger.log(`REJECTED ${intent.intentAction} ${intent.symbol} reason=${reason}`);

        return {
            outcome: RiskOutcomeEnum.REJECTED,
            rejectReason: reason,
            approvedSlot: null,
            approvedSizing: null,
            clampedExit: null,
            reservationId: null,
            haltReasonDetail,
        };
    }

    private utcDateMinusDays(dateString: string, days: number): string {
        const base = new Date(`${dateString}T00:00:00.000Z`);
        base.setUTCDate(base.getUTCDate() - days);

        return base.toISOString().slice(0, 10);
    }
}

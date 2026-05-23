import { CoinTierEnum, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { MS_PER_MINUTE } from '../../common/const';
import { Money, MoneyValue } from '../../common/utils/money';
import { CANDLE_INTERVAL_MS } from '../../strategy/const';
import { IProposedExit } from '../../strategy/interface';
import {
    AGG_TRADE_BUY_FLOW_BALANCE,
    CONSECUTIVE_LOSS_HALT_COUNT,
    LIQUIDATION_SAFETY_BUFFER_FACTOR,
    MAX_LEVERAGE,
    RESERVATION_TTL_MS,
    TIER3_VALIDATED_VERSION_IDS,
    TIER_SPREAD_CEILING_PCT,
    WEEKLY_LOSS_WINDOW_DAYS,
} from '../const';
import { ReservationStateEnum } from '../enum';
import { IClosedPositionView, IExposureReservation, IOpenPositionView, IOrderIntent, IRiskDecision, IRiskGateContext, IRiskStateDay } from '../interface';
import { ReservationLedger } from './ReservationLedger';
import { IOccupiedSlot, SlotAssignment, SlotManager } from './SlotManager';
import { StressHaltEvaluator } from './StressHaltEvaluator';

const MAX_LEVERAGE_DEC = new Money(MAX_LEVERAGE);

// The state the gate loads ONCE per evaluate and threads down, so getDay/findOpen are not
// re-queried per check (the decision logic stays pure — it reads this snapshot, not the DB).
interface ILoadedState {
    readonly today: IRiskStateDay | null;
    readonly openPositions: IOpenPositionView[];
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

    constructor(
        private readonly ledger: ReservationLedger,
        private readonly slotManager: SlotManager,
        private readonly stress: StressHaltEvaluator,
    ) {}

    async evaluate(intent: IOrderIntent, context: IRiskGateContext): Promise<IRiskDecision> {
        if (this.isDeRisking(intent.intentAction)) {
            return this.approveDeRisking(intent);
        }

        return this.evaluateEntry(intent, context);
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
        };
    }

    // The ordered check pipeline for open/add (ADR 0004 §2). The first failing check
    // short-circuits and returns its RejectReasonEnum. Order is fixed for replay determinism.
    private async evaluateEntry(intent: IOrderIntent, context: IRiskGateContext): Promise<IRiskDecision> {
        const state = await this.loadState(context);

        const reject = await this.firstFailingCheck(intent, context, state);

        if (reject !== null) {
            return this.rejected(intent, reject);
        }

        const slot = this.assignSlot(intent, context, state);

        if (slot.kind === 'rejected') {
            return this.rejected(intent, slot.reason);
        }

        const clampedExit = this.clampStopInsideLiquidation(intent);

        if (clampedExit === null) {
            return this.rejected(intent, RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        }

        return this.reserveAndApprove(intent, context, state, slot.slot, clampedExit);
    }

    // Load the durable state ONCE (MEDIUM: no repeated getDay/findOpen per evaluate).
    private async loadState(context: IRiskGateContext): Promise<ILoadedState> {
        const [today, openPositions] = await Promise.all([context.riskState.getDay(context.utcDateString), context.openPositions.findOpen()]);

        return { today, openPositions };
    }

    private async firstFailingCheck(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState): Promise<RejectReasonEnum | null> {
        const haltReason = await this.firstFailingHaltCheck(context, state);

        if (haltReason !== null) {
            return haltReason;
        }

        const tierReason = this.firstFailingTierFilter(intent, context);

        if (tierReason !== null) {
            return tierReason;
        }

        return this.checkStatefulLimits(intent, context, state);
    }

    // Global-halt + stress filters. A fresh stress verdict is recorded DURABLY on risk_state
    // (is_halted=true, halt_reason='market_stress') so the GLOBAL_HALT re-entry block and M9
    // (Telegram) both see it; the upsert is idempotent on the UTC-day key (replay-safe).
    private async firstFailingHaltCheck(context: IRiskGateContext, state: ILoadedState): Promise<RejectReasonEnum | null> {
        if (!Number.isFinite(context.nowMs)) {
            return RejectReasonEnum.GLOBAL_HALT;
        }

        if (context.modelDivergenceDetected) {
            return RejectReasonEnum.MODEL_DIVERGENCE_HALT;
        }

        if (state.today !== null && state.today.isHalted) {
            return RejectReasonEnum.GLOBAL_HALT;
        }

        if (this.stress.isStressed(context.snapshot, context.params)) {
            await this.persistHalt(context, state, RejectReasonEnum.MARKET_STRESS);

            return RejectReasonEnum.MARKET_STRESS;
        }

        return null;
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

        if (this.isTier3Unvalidated(intent, context)) {
            return RejectReasonEnum.TIER3_NOT_VALIDATED;
        }

        return null;
    }

    private async checkStatefulLimits(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState): Promise<RejectReasonEnum | null> {
        if (await this.isCooldownActive(intent, context)) {
            return RejectReasonEnum.COOLDOWN_ACTIVE;
        }

        const lossWindowReason = await this.checkLossWindows(context, state);

        if (lossWindowReason !== null) {
            return lossWindowReason;
        }

        const overtradingReason = await this.checkOvertradingCaps(intent, context);

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
    // Idempotent on the UTC-day key so a replay or a re-trigger never double-applies.
    private async persistHalt(context: IRiskGateContext, state: ILoadedState, reason: RejectReasonEnum): Promise<void> {
        if (state.today !== null && state.today.isHalted) {
            return;
        }

        const base = state.today ?? this.emptyDay(context.utcDateString);

        await context.riskState.upsertDay({ ...base, isHalted: true, haltReason: reason });
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
    private async checkOvertradingCaps(intent: IOrderIntent, context: IRiskGateContext): Promise<RejectReasonEnum | null> {
        const perSymbolToday = await context.openPositions.countOpenedOnUtcDayForSymbol(intent.symbol, context.utcDateString);

        if (perSymbolToday >= context.params.max_trades_per_symbol_per_day) {
            return RejectReasonEnum.MAX_TRADES_PER_SYMBOL_PER_DAY;
        }

        if (this.barWindowReservationCount(context.nowMs) >= context.params.max_trades_per_bar_universe) {
            return RejectReasonEnum.MAX_TRADES_PER_BAR_UNIVERSE;
        }

        return null;
    }

    // Bar-index match (NOT a `[barOpen, nowMs)` window). Every reservation in one bar shares
    // createdAtMs === context.nowMs (the deterministic bar-close clock), so a `< nowMs` upper
    // bound would exclude same-bar siblings and the per-bar cap would never fire in live.
    private barWindowReservationCount(nowMs: number): number {
        const currentBarIndex = Math.floor(nowMs / CANDLE_INTERVAL_MS);

        return this.ledger.listActive().filter((reservation) => Math.floor(reservation.createdAtMs / CANDLE_INTERVAL_MS) === currentBarIndex).length;
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

    private assignSlot(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState): SlotAssignment {
        const occupied = this.occupiedSlots(state);

        return this.slotManager.assign(intent.correlationMode, intent.idiosyncrasyScore, context.params.idiosyncrasy_min_score, occupied);
    }

    private occupiedSlots(state: ILoadedState): IOccupiedSlot[] {
        const fromPositions: IOccupiedSlot[] = state.openPositions
            .filter((position) => position.slot !== null)
            .map((position) => ({ slot: position.slot as PositionSlotEnum, correlationMode: position.correlationMode }));

        const fromReservations: IOccupiedSlot[] = this.ledger.listActive().map((reservation) => ({
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
    ): Promise<IRiskDecision> {
        const exposureReason = this.checkExposureCaps(intent, context, state);

        if (exposureReason !== null) {
            return this.rejected(intent, exposureReason);
        }

        const timeStopReason = this.checkTimeStop(intent, context);

        if (timeStopReason !== null) {
            return this.rejected(intent, timeStopReason);
        }

        const reservation = this.buildReservation(intent, context, slot);
        this.ledger.reserve(reservation);

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
        };
    }

    private checkExposureCaps(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState): RejectReasonEnum | null {
        const active = this.ledger.listActive();

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

    private rejected(intent: IOrderIntent, reason: RejectReasonEnum): IRiskDecision {
        this.logger.log(`REJECTED ${intent.intentAction} ${intent.symbol} reason=${reason}`);

        return {
            outcome: RiskOutcomeEnum.REJECTED,
            rejectReason: reason,
            approvedSlot: null,
            approvedSizing: null,
            clampedExit: null,
            reservationId: null,
        };
    }

    private utcDateMinusDays(dateString: string, days: number): string {
        const base = new Date(`${dateString}T00:00:00.000Z`);
        base.setUTCDate(base.getUTCDate() - days);

        return base.toISOString().slice(0, 10);
    }
}

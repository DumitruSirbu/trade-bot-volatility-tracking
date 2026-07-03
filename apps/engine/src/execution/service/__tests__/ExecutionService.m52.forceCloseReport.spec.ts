/**
 * ExecutionService — M52 D1 force_close report event (ADR 0051 §2.1).
 *
 * Adversarial coverage for `emitMomentumForceCloseReport` / `computeGeometryAnchorDrift`, exercised
 * indirectly via the FA2-style D2 reject path (`openOrAddPositionAndAttachProtection` →
 * `rejectAndUnwindIfUnacceptable` → `unwindRejectedFill` → `emitMomentumForceCloseReport`). This seam
 * had ZERO test coverage before this file — the M38 fill-acceptance spec asserts `emitSyntheticClose`
 * and `releaseReservation` but never inspects the MOMENTUM_FILL_FORCE_CLOSED_EVENT emission.
 *
 * Coverage map:
 *   FC1 — momentum OPEN (rebalanceCycleId stamped) rejected → MOMENTUM_FILL_FORCE_CLOSED_EVENT emitted
 *         with atrUnitsDrift/driftPct matching the GEOMETRY_ANCHOR_DRIFT computation, rank/symbol/
 *         strategyVersionId/reason correctly carried.
 *   FC2 — non-momentum OPEN (no rebalanceCycleId) rejected → NO force_close report emitted (no-op).
 *   FC3 — rebalanceCycleId present but entrySnapshot/geometryParams missing (drift unresolvable) →
 *         NO force_close report emitted, no crash.
 *   FC4 — reservation is released BEFORE the force_close report is emitted (ADR 0051 §3.4 ordering).
 *   FC5 — rank is carried through unmodified (never a 0 fallback) since the orchestrator always
 *         stamps rank alongside rebalanceCycleId — the two are a paired invariant.
 *   FC6 — a fill that passes D2 (not rejected) never emits a force_close report.
 */

import { IMarketSnapshot, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, ProtectiveOrderTypeEnum, StopTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { MOMENTUM_FILL_FORCE_CLOSED_EVENT } from '../../../common/const';
import { IMomentumFillForceClosedEvent } from '../../../common/interface';
import { IOrderIntentApprovedEvent } from '../../../risk/interface';
import { ExecutionService } from '../ExecutionService';

const FILL_PRICE = '50520';
const SL_PRICE = '50000'; // rejects when fill is AT or below SL for LONG
const REFERENCE_PRICE = '50000';
const ATR_14 = '100';
const CYCLE_ID = 'xmom-cycle-1700000000000-scheduled';

function buildSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 1.01,
        vwap_deviation_sigma: 1.5,
        volume_ratio: 1.8,
        volume_20bar_avg: '1000000',
        atr_14: ATR_14,
        adx_14: 25,
        adx_di_plus: 20,
        adx_di_minus: 12,
        rsi_14: 60,
        bollinger_upper: '51000',
        bollinger_lower: '49000',
        bollinger_pct_b: 0.7,
        btc_5m_move_pct: 0.3,
        btc_1m_move_pct: 0.1,
        eth_5m_move_pct: 0.5,
        market_breadth_5m_up_pct: 60,
        same_bar_trigger_count: 2,
        open_interest_change_5m_pct: 0.15,
        open_interest_change_15m_pct: 0.4,
        open_interest: '9999999',
        funding_rate: 0.0002,
        funding_rate_annualized: 0.219,
        bid_ask_spread_pct: 0.04,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: '12000000',
        book_depth_50bps_usdt: '50000000',
        coin_tier: 'tier_1' as any,
        coin_volume_rank: 1,
        correlation_mode: 'idiosyncratic' as any,
        signal_score: 82,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.55,
        idiosyncrasy_score: 0.72,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 120,
        flow_type: 'trend_initiation' as any,
        ...overrides,
    };
}

// Defaults are shaped to REJECT at the wrong-side-of-SL leg (SL == reference price) so most FC
// tests exercise the reject/report path with a one-line fillSummary(SL_PRICE) call. FC6 (accepted
// fill) overrides SL/TP so the M48 geometry-integrity leg (RR + slFloor) also passes.
function buildMomentumClampedExit(overrides: { stopLossPrice?: string; takeProfitPrice?: string } = {}) {
    const { stopLossPrice = SL_PRICE, takeProfitPrice = '50705' } = overrides;

    return {
        takeProfitPrice: new Money(takeProfitPrice),
        stopLossPrice: new Money(stopLossPrice),
        stopType: StopTypeEnum.ATR,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: false,
        atrDistance: new Money(ATR_14),
    };
}

// Builds an approved-open event, optionally momentum-shaped (rebalanceCycleId + rank stamped, matching
// what MomentumOrchestratorService.buildMomentumOpenIntent stamps — ADR 0051 §2.1).
function buildApprovedEvent(
    overrides: {
        momentum?: boolean;
        rank?: number;
        entrySnapshot?: IMarketSnapshot;
        omitEntrySnapshot?: boolean;
        geometryParams?: { min_rr: number; atr_floor_multiplier: number; entry_pct_floor: number };
        omitGeometryParams?: boolean;
        strategyVersionId?: number;
        clampedExit?: { stopLossPrice?: string; takeProfitPrice?: string };
    } = {},
): IOrderIntentApprovedEvent {
    const {
        momentum = true,
        rank = 2,
        entrySnapshot = buildSnapshot(),
        omitEntrySnapshot = false,
        geometryParams = { min_rr: 1.5, atr_floor_multiplier: 1, entry_pct_floor: 0.3 },
        omitGeometryParams = false,
        strategyVersionId = 20,
        clampedExit = {},
    } = overrides;

    return {
        intent: {
            intentAction: OrderIntentActionEnum.OPEN,
            symbol: 'FARTCOINUSDT',
            eventId: 'xmom-open-FARTCOINUSDT-1700000000000-scheduled',
            tradeSide: PositionSideEnum.LONG,
            signalScore: 50,
            correlationMode: 'idiosyncratic' as any,
            coinTier: 'tier_1' as any,
            idiosyncrasyScore: 1,
            entryPrice: new Money(REFERENCE_PRICE),
            referencePrice: new Money(REFERENCE_PRICE),
            midAtTrigger: new Money(REFERENCE_PRICE),
            maintenanceMarginRate: new Money('0.005'),
            proposedExit: buildMomentumClampedExit(clampedExit),
            openPosition: null,
            sizing: {
                qty: new Money('0.02'),
                notional: new Money('1010.1'),
                leverage: new Money('2'),
                riskPerTradeUsdt: new Money('20'),
                effectiveRiskUsdt: new Money('20'),
            },
            flowType: 'trend_initiation' as any,
            ...(momentum ? { rebalanceCycleId: CYCLE_ID, rank } : {}),
        },
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: {
            qty: new Money('0.02'),
            notional: new Money('1010.1'),
            leverage: new Money('2'),
            riskPerTradeUsdt: new Money('20'),
            effectiveRiskUsdt: new Money('20'),
        },
        clampedExit: buildMomentumClampedExit(clampedExit),
        reservationId: 'test-reservation',
        entrySnapshot: omitEntrySnapshot ? undefined : entrySnapshot,
        geometryParams: omitGeometryParams ? undefined : geometryParams,
        strategyVersionId,
    } as unknown as IOrderIntentApprovedEvent;
}

function buildFillSummary(price: string) {
    return {
        filledQty: new Money('0.02'),
        avgFillPrice: new Money(price),
        filledNotional: new Money(new Money(price).times(new Money('0.02')).toFixed(8)),
        feeTotal: new Money('0.5'),
    };
}

function buildPositionRow(id = 42) {
    return {
        id,
        symbol: 'FARTCOINUSDT',
        side: PositionSideEnum.LONG,
        qty: new Money('0.02'),
        entryPrice: new Money(FILL_PRICE),
        entryNotional: new Money('1010.4'),
        leverage: new Money('2'),
        strategyVersionId: 20,
        flowTypeAtEntry: 'trend_initiation',
        correlationMode: 'idiosyncratic',
        coinTier: 'tier_1',
        stopLossPrice: new Money(SL_PRICE),
        takeProfitPrice: new Money('50705'),
    } as any;
}

function buildService(
    overrides: {
        events?: any;
        riskGate?: any;
        positionCloseCoordinator?: any;
    } = {},
): ExecutionService {
    const {
        events = { emit: jest.fn() },
        riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() },
        positionCloseCoordinator = { emitSyntheticClose: jest.fn().mockResolvedValue(undefined) },
    } = overrides;

    return new ExecutionService(
        { isExecutionLive: false } as any,
        { plan: jest.fn() } as any,
        { build: jest.fn() } as any,
        { submit: jest.fn() } as any,
        { accumulate: jest.fn(), forget: jest.fn() } as any,
        { attach: jest.fn().mockResolvedValue({ protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE, exchangeOrderId: 'tp-order-id' }) } as any,
        { arm: jest.fn(), disarm: jest.fn() } as any,
        {
            createOpen: jest.fn().mockResolvedValue(buildPositionRow()),
            save: jest.fn().mockResolvedValue(buildPositionRow()),
            updateForceCloseAtrUnitsDrift: jest.fn().mockResolvedValue(undefined),
            findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(null),
        } as any,
        { transition: jest.fn().mockResolvedValue(undefined), adjustQty: jest.fn(), finalizeRealizedPnl: jest.fn() } as any,
        { recordTerminal: jest.fn().mockResolvedValue(undefined) } as any,
        { findById: jest.fn().mockResolvedValue({ direction: 'both' }) } as any,
        riskGate,
        { isHalted: jest.fn().mockReturnValue(false), getReason: jest.fn() } as any,
        positionCloseCoordinator,
        {} as any,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any,
        { onPositionOpened: jest.fn(), applyEntryTick: jest.fn() } as never,
    );
}

function findForceCloseReport(emitSpy: jest.Mock): IMomentumFillForceClosedEvent | undefined {
    const call = emitSpy.mock.calls.find(([eventName]) => eventName === MOMENTUM_FILL_FORCE_CLOSED_EVENT);

    return call?.[1];
}

describe('ExecutionService M52 D1 — FC1: momentum OPEN reject emits MOMENTUM_FILL_FORCE_CLOSED_EVENT', () => {
    it('emits the report with atrUnitsDrift/driftPct matching computeGeometryAnchorDrift, and rank/symbol/version carried', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        const event = buildApprovedEvent({ momentum: true, rank: 2, strategyVersionId: 20 });
        // Fill AT SL = wrong-side for LONG → D2 rejects.
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        const report = findForceCloseReport(emitSpy);
        expect(report).toBeDefined();
        expect(report!.rebalanceCycleId).toBe(CYCLE_ID);
        expect(report!.symbol).toBe('FARTCOINUSDT');
        expect(report!.rank).toBe(2);
        expect(report!.strategyVersionId).toBe(20);

        // Same math as logGeometryAnchorDrift: |fill - reference| / reference * 100, and / atr14.
        const fill = new Money(SL_PRICE);
        const ref = new Money(REFERENCE_PRICE);
        const expectedDriftPct = fill.minus(ref).abs().dividedBy(ref).times(100);
        const expectedAtrUnits = fill.minus(ref).abs().dividedBy(new Money(ATR_14));

        expect(report!.driftPct.toFixed(6)).toBe(expectedDriftPct.toFixed(6));
        expect(report!.atrUnitsDrift.toFixed(6)).toBe(expectedAtrUnits.toFixed(6));
    });
});

describe('ExecutionService M52 D1 — FC2: non-momentum OPEN reject is a no-op for the report event', () => {
    it('does NOT emit MOMENTUM_FILL_FORCE_CLOSED_EVENT when the intent carries no rebalanceCycleId', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        const event = buildApprovedEvent({ momentum: false });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(findForceCloseReport(emitSpy)).toBeUndefined();
    });
});

describe('ExecutionService M52 D1 — FC3: drift unresolvable (missing snapshot/geometry) → no report, no crash', () => {
    it('emits no force_close report when entrySnapshot is undefined despite a momentum-stamped intent', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        const event = buildApprovedEvent({ momentum: true, omitEntrySnapshot: true });
        const fillSummary = buildFillSummary(SL_PRICE);

        await expect((service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now())).resolves.toBeUndefined();

        expect(findForceCloseReport(emitSpy)).toBeUndefined();
    });

    it('emits no force_close report when geometryParams is undefined despite entrySnapshot present', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        const event = buildApprovedEvent({ momentum: true, omitGeometryParams: true });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(findForceCloseReport(emitSpy)).toBeUndefined();
    });
});

describe('ExecutionService M52 D1 — FC4: reservation release happens BEFORE the force_close report (ADR 0051 §3.4)', () => {
    it('releaseReservation is called before events.emit(MOMENTUM_FILL_FORCE_CLOSED_EVENT)', async () => {
        const callOrder: string[] = [];
        const releaseSpy = jest.fn(() => callOrder.push('release'));
        const emitSpy = jest.fn((eventName: string) => {
            if (eventName === MOMENTUM_FILL_FORCE_CLOSED_EVENT) {
                callOrder.push('report');
            }
        });
        const service = buildService({
            riskGate: { releaseReservation: releaseSpy, confirmReservation: jest.fn() },
            events: { emit: emitSpy },
        });

        const event = buildApprovedEvent({ momentum: true });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(callOrder).toEqual(['release', 'report']);
    });
});

describe('ExecutionService M52 D1 — FC5: rank is carried through unmodified', () => {
    it('reports the stamped rank for a momentum-cycle-stamped intent, never a fallback value', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        const event = buildApprovedEvent({ momentum: true, rank: 2 });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        const report = findForceCloseReport(emitSpy);
        expect(report).toBeDefined();
        expect(report!.rank).toBe(2);
    });
});

describe('ExecutionService M52 D1 — FC6: an accepted fill never emits a force_close report', () => {
    it('emits no MOMENTUM_FILL_FORCE_CLOSED_EVENT when D2 does not reject the fill', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        // SL/TP wide enough to clear BOTH the wrong-side-of-SL leg AND the M48 RR/slFloor leg:
        // slDist = 50520 - 49000 = 1520 (>= slFloor 150), tpDist = 53000 - 50520 = 2480,
        // ratio = 2480/1520 = 1.63 >= min_rr 1.5.
        const event = buildApprovedEvent({ momentum: true, clampedExit: { stopLossPrice: '49000', takeProfitPrice: '53000' } });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(findForceCloseReport(emitSpy)).toBeUndefined();
    });
});

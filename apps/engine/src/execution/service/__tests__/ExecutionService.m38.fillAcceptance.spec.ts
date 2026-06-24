/**
 * ExecutionService — M38 D1/D2 fill-acceptance tests (ADR 0045)
 *
 * Surfaces under test (all via the private seam `rejectFillIfUnacceptable` and
 * `openOrAddPositionAndAttachProtection`, exercised via `(service as any).*`):
 *
 *   FA1  — Happy path LONG fill above SL: arm called with REBASED TP, attach called,
 *           POSITION_OPENED_EVENT emitted, no emitSyntheticClose
 *   FA2  — D2 reject LONG fill at SL (wrong-side): emitSyntheticClose called with FORCE_CLOSE,
 *           arm NOT called, attach NOT called, POSITION_OPENED_EVENT NOT emitted,
 *           reservation released (not confirmed — avoids phantom slot occupancy)
 *   FA3  — D2 reject SHORT fill at SL (wrong-side): same pattern as FA2 for SHORT
 *   FA4  — D1 + D2 interact: LONG momentum fill with drift, D2 passes, arm receives
 *           fill+atrDistance (rebased TP), NOT the frozen signal TP
 *   FA5  — Mean-reversion LONG: tpRebaseEligible=false → arm receives the ORIGINAL
 *           clampedExit.takeProfitPrice unchanged
 *   FA6  — ADD intent: neither D1 rebase nor D2 gate triggers (no emitSyntheticClose,
 *           arm not called on ADD path)
 *   FA7  — D1 fallback: tpRebaseEligible=true but atrDistance=null → arm receives frozen TP,
 *           no crash
 *   FA8  — Boundary: atrDistance=0 → rebased TP equals fill price; no unexpected behavior
 *   FA9  — PENDING_OPEN closing fill: promote syncs in-memory state before save → CLOSING reachable
 */

import {
    ExitReasonEnum,
    IMarketSnapshot,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    StopTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { POSITION_OPENED_EVENT } from '../../../common/const';
import { IOrderIntentApprovedEvent } from '../../../risk/interface';
import { ExecutionService } from '../ExecutionService';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const FILL_PRICE = '50520'; // fill drifted above signal
const SL_PRICE = '50000'; // VWAP stop
const ATR_DISTANCE = new Money('200'); // atr14(100) * MULTIPLIER(2.0)
// Frozen signal-time TP (signal at ~50505, ABOVE deviation):
const FROZEN_TP = new Money('50705'); // signal + atrDistance = 50505 + 200

function buildSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 1.01,
        vwap_deviation_sigma: 1.5,
        volume_ratio: 1.8,
        volume_20bar_avg: '1000000',
        atr_14: '100',
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

function buildMomentumClampedExit(
    overrides: Partial<{
        takeProfitPrice: any;
        stopLossPrice: any;
        atrDistance: any;
        tpRebaseEligible: boolean;
    }> = {},
) {
    return {
        takeProfitPrice: FROZEN_TP,
        stopLossPrice: new Money(SL_PRICE),
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: true,
        atrDistance: ATR_DISTANCE,
        ...overrides,
    };
}

function buildApprovedEvent(
    overrides: {
        intentAction?: OrderIntentActionEnum;
        tradeSide?: PositionSideEnum;
        clampedExit?: any;
        entrySnapshot?: IMarketSnapshot;
    } = {},
): IOrderIntentApprovedEvent {
    const {
        intentAction = OrderIntentActionEnum.OPEN,
        tradeSide = PositionSideEnum.LONG,
        clampedExit = buildMomentumClampedExit(),
        entrySnapshot = buildSnapshot(),
    } = overrides;

    return {
        intent: {
            intentAction,
            symbol: 'BTCUSDT',
            eventId: 'BTCUSDT:1700000000000',
            tradeSide,
            signalScore: 80,
            correlationMode: 'idiosyncratic' as any,
            coinTier: 'tier_1' as any,
            idiosyncrasyScore: 0.72,
            entryPrice: new Money('50505'),
            midAtTrigger: new Money('50505'),
            maintenanceMarginRate: new Money('0.005'),
            proposedExit: clampedExit,
            openPosition: null,
            sizing: {
                qty: new Money('0.02'),
                notional: new Money('1010.1'),
                leverage: new Money('2'),
                riskPerTradeUsdt: new Money('20'),
                effectiveRiskUsdt: new Money('20'),
            },
            flowType: 'trend_initiation' as any,
        },
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: {
            qty: new Money('0.02'),
            notional: new Money('1010.1'),
            leverage: new Money('2'),
            riskPerTradeUsdt: new Money('20'),
            effectiveRiskUsdt: new Money('20'),
        },
        clampedExit,
        reservationId: 'test-reservation',
        entrySnapshot,
        strategyVersionId: 2,
    };
}

function buildFillSummary(price: string = FILL_PRICE) {
    return {
        filledQty: new Money('0.02'),
        avgFillPrice: new Money(price),
        filledNotional: new Money(new Money(price).times(new Money('0.02')).toFixed(8)),
        feeTotal: new Money('0.5'),
    };
}

function buildPositionRow(id = 42, side = PositionSideEnum.LONG) {
    return {
        id,
        symbol: 'BTCUSDT',
        side,
        qty: new Money('0.02'),
        entryPrice: new Money(FILL_PRICE),
        entryNotional: new Money('1010.4'),
        leverage: new Money('2'),
        strategyVersionId: 2,
        flowTypeAtEntry: 'trend_initiation',
        correlationMode: 'idiosyncratic',
        coinTier: 'tier_1',
        stopLossPrice: new Money(SL_PRICE),
        takeProfitPrice: FROZEN_TP,
    } as any;
}

// Build ExecutionService with minimal mocks — copies the pattern from
// ExecutionService.m35.entrySnapshot.spec.ts exactly.
function buildService(
    overrides: {
        positionCloseCoordinator?: any;
        localProtectiveMonitor?: any;
        events?: any;
        positions?: any;
        positionService?: any;
        protectiveAttacher?: any;
        riskGate?: any;
    } = {},
): ExecutionService {
    const {
        positionCloseCoordinator = { emitSyntheticClose: jest.fn().mockResolvedValue(undefined) },
        localProtectiveMonitor = { arm: jest.fn(), disarm: jest.fn() },
        events = { emit: jest.fn() },
        positions = {
            createOpen: jest.fn().mockResolvedValue(buildPositionRow()),
            save: jest.fn().mockResolvedValue(buildPositionRow()),
            findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(null),
        },
        positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
            adjustQty: jest.fn(),
            finalizeRealizedPnl: jest.fn(),
        },
        protectiveAttacher = {
            attach: jest.fn().mockResolvedValue({
                protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
                exchangeOrderId: 'tp-order-id',
            }),
        },
        riskGate = {
            releaseReservation: jest.fn(),
            confirmReservation: jest.fn(),
        },
    } = overrides;

    return new ExecutionService(
        { isExecutionLive: false } as any, // appConfig
        { plan: jest.fn() } as any, // policyRouter
        { build: jest.fn() } as any, // clientOrderIdFactory
        { submit: jest.fn() } as any, // submitter
        { accumulate: jest.fn(), forget: jest.fn() } as any, // fillAccumulator
        protectiveAttacher, // protectiveAttacher
        localProtectiveMonitor, // localProtectiveMonitor
        positions, // positions
        positionService, // positionService
        { recordTerminal: jest.fn().mockResolvedValue(undefined) } as any, // transactions
        { findById: jest.fn().mockResolvedValue({ direction: 'both' }) } as any, // strategyVersions
        riskGate, // riskGate
        { isHalted: jest.fn().mockReturnValue(false), getReason: jest.fn() } as any, // haltFlag
        positionCloseCoordinator, // positionCloseCoordinator
        {} as any, // exchangeClient
        events, // events
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any, // riskState
    );
}

// ─── FA1: Happy path LONG fill above SL — arm called with rebased TP ──────────

describe('ExecutionService M38 — FA1: LONG fill above SL → arm called with rebased TP, POSITION_OPENED_EVENT emitted', () => {
    it('arm is called with resolvedTakeProfitPrice = fill + atrDistance (D1 rebase)', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(FILL_PRICE); // fill above SL

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).toHaveBeenCalledTimes(1);
        const armCall = armSpy.mock.calls[0][0];
        // Rebased TP = fill(50520) + atrDistance(200) = 50720
        const expectedTp = new Money(FILL_PRICE).plus(ATR_DISTANCE);
        expect(armCall.takeProfitPrice.toFixed(2)).toBe(expectedTp.toFixed(2));
        // SL is NOT rebased
        expect(armCall.stopLossPrice.toFixed(2)).toBe(new Money(SL_PRICE).toFixed(2));
    });

    it('POSITION_OPENED_EVENT is emitted on a valid fill (D2 does not reject)', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            events: { emit: emitSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        const openedEmit = emitSpy.mock.calls.find(([eventName]) => eventName === POSITION_OPENED_EVENT);
        expect(openedEmit).toBeDefined();
    });

    it('emitSyntheticClose is NOT called on a valid fill', async () => {
        const syntheticCloseSpy = jest.fn();
        const service = buildService({
            positionCloseCoordinator: { emitSyntheticClose: syntheticCloseSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(syntheticCloseSpy).not.toHaveBeenCalled();
    });
});

// ─── FA2: D2 reject — LONG fill at SL (wrong-side) ──────────────────────────

describe('ExecutionService M38 — FA2: LONG fill at SL (wrong-side) → emitSyntheticClose called, arm/attach/event skipped', () => {
    it('emitSyntheticClose is called with FORCE_CLOSE when LONG fill is at SL', async () => {
        const syntheticCloseSpy = jest.fn().mockResolvedValue(undefined);
        const service = buildService({
            positionCloseCoordinator: { emitSyntheticClose: syntheticCloseSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        // Fill exactly at SL = wrong-side for LONG (≤ boundary)
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(syntheticCloseSpy).toHaveBeenCalledTimes(1);
        const callArg = syntheticCloseSpy.mock.calls[0][0] as { exitReason: string };
        expect(callArg.exitReason).toBe(ExitReasonEnum.FORCE_CLOSE);
    });

    it('arm is NOT called when D2 rejects the fill', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(SL_PRICE); // at SL = wrong-side for LONG

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).not.toHaveBeenCalled();
    });

    it('protectiveAttacher.attach is NOT called when D2 rejects the fill', async () => {
        const attachSpy = jest.fn();
        const service = buildService({
            protectiveAttacher: { attach: attachSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(attachSpy).not.toHaveBeenCalled();
    });

    it('POSITION_OPENED_EVENT is NOT emitted when D2 rejects the fill', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            events: { emit: emitSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        const openedEmit = emitSpy.mock.calls.find(([eventName]) => eventName === POSITION_OPENED_EVENT);
        expect(openedEmit).toBeUndefined();
    });

    it('releaseReservation is called (not confirmReservation) so the slot is not phantom-occupied', async () => {
        const releaseSpy = jest.fn();
        const confirmSpy = jest.fn();
        const service = buildService({
            riskGate: { releaseReservation: releaseSpy, confirmReservation: confirmSpy },
        });

        const event = buildApprovedEvent({ tradeSide: PositionSideEnum.LONG });
        const fillSummary = buildFillSummary(SL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(releaseSpy).toHaveBeenCalledWith('test-reservation');
        expect(confirmSpy).not.toHaveBeenCalled();
    });
});

// ─── FA3: D2 reject — SHORT fill at SL (wrong-side) ─────────────────────────

describe('ExecutionService M38 — FA3: SHORT fill at SL (wrong-side) → emitSyntheticClose, arm/attach/event skipped', () => {
    it('emitSyntheticClose is called with FORCE_CLOSE when SHORT fill is at SL', async () => {
        const syntheticCloseSpy = jest.fn().mockResolvedValue(undefined);
        const service = buildService({
            positionCloseCoordinator: { emitSyntheticClose: syntheticCloseSpy },
        });

        // SHORT: SL is above the entry (wick stop). Fill at or above SL = wrong-side
        const shortSl = '50600'; // wick stop above entry
        const clampedExit = buildMomentumClampedExit({ stopLossPrice: new Money(shortSl) });
        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.SHORT,
            clampedExit,
        });
        // Fill at SL = exactly at boundary = wrong-side for SHORT (≥ boundary)
        const fillSummary = buildFillSummary(shortSl);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(syntheticCloseSpy).toHaveBeenCalledTimes(1);
        const callArg = syntheticCloseSpy.mock.calls[0][0] as { exitReason: string };
        expect(callArg.exitReason).toBe(ExitReasonEnum.FORCE_CLOSE);
    });

    it('arm is NOT called when SHORT D2 rejects the fill', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        const shortSl = '50600';
        const clampedExit = buildMomentumClampedExit({ stopLossPrice: new Money(shortSl) });
        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.SHORT,
            clampedExit,
        });
        const fillSummary = buildFillSummary(shortSl);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).not.toHaveBeenCalled();
    });
});

// ─── FA4: D1 + D2 interact — fill barely above SL but wrong-side frozen TP ───

describe('ExecutionService M38 — FA4: D1+D2 interact — valid fill with drift uses rebased TP (not frozen signal TP)', () => {
    it('when fill drifts from signal but is above SL, arm receives fill+atrDistance NOT frozen TP', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        // The key M38 bug case: signal-time TP would be WRONG-SIDE (frozen signal TP below fill)
        // but D1 rebase corrects it to fill+ATR (above entry for LONG).
        const driftedFill = '50600'; // fill above SL(50000), above signal ~50505
        const frozenTpBelowFill = new Money('50300'); // signal-time TP (wrong-side of fill for LONG)
        const clampedExit = buildMomentumClampedExit({
            takeProfitPrice: frozenTpBelowFill,
            stopLossPrice: new Money(SL_PRICE),
            atrDistance: ATR_DISTANCE,
            tpRebaseEligible: true,
        });

        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.LONG,
            clampedExit,
        });
        const fillSummary = buildFillSummary(driftedFill);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).toHaveBeenCalledTimes(1);
        const armCall = armSpy.mock.calls[0][0];
        // D1 rebased TP = fill(50600) + atrDistance(200) = 50800 (above fill, correct)
        const expectedRebasedTp = new Money(driftedFill).plus(ATR_DISTANCE);
        expect(armCall.takeProfitPrice.toFixed(2)).toBe(expectedRebasedTp.toFixed(2));
        // NOT the wrong-side frozen TP
        expect(armCall.takeProfitPrice.toFixed(2)).not.toBe(frozenTpBelowFill.toFixed(2));
    });
});

// ─── FA5: Mean-reversion — no D1 rebase, frozen TP preserved ──────────────────

describe('ExecutionService M38 — FA5: mean-reversion (tpRebaseEligible=false) — arm receives ORIGINAL frozen TP', () => {
    it('arm receives the original clampedExit.takeProfitPrice unchanged on mean-reversion path (SHORT fade)', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        // Mean-reversion SHORT fade: entry above VWAP, VWAP below entry.
        // D2 for SHORT: fill ≥ SL → reject. To pass: fill < SL.
        // SL = wick stop ABOVE entry (structural), fill is below the wick stop → D2 passes.
        const meanRevFill = '50600';
        const wickStop = '51500'; // wick stop ABOVE fill for SHORT fade
        const frozenTp = new Money('50100'); // VWAP-anchored target below fill for SHORT
        const clampedExit = {
            takeProfitPrice: frozenTp,
            stopLossPrice: new Money(wickStop), // above fill for SHORT → D2 passes (fill < SL)
            stopType: StopTypeEnum.STRUCTURAL,
            timeStopAtMs: 1_700_000_000_000 + 3_600_000,
            tpRebaseEligible: false,
            atrDistance: null,
        };

        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.SHORT,
            clampedExit,
        });
        const fillSummary = buildFillSummary(meanRevFill);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).toHaveBeenCalledTimes(1);
        const armCall = armSpy.mock.calls[0][0];
        // Must be the frozen VWAP-anchored TP, NOT fill ± ATR
        expect(armCall.takeProfitPrice.toFixed(2)).toBe(frozenTp.toFixed(2));
    });
});

// ─── FA6: ADD intent — D1/D2 not applied ─────────────────────────────────────

describe('ExecutionService M38 — FA6: ADD intent — D1 rebase and D2 gate do NOT apply', () => {
    it('emitSyntheticClose is NOT called on an ADD fill even if the fill would be wrong-side for OPEN', async () => {
        const syntheticCloseSpy = jest.fn().mockResolvedValue(undefined);
        const service = buildService({
            positionCloseCoordinator: { emitSyntheticClose: syntheticCloseSpy },
            // Provide an existing position so the ADD path finds it
            positions: {
                createOpen: jest.fn(),
                save: jest.fn().mockResolvedValue(buildPositionRow()),
                findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(buildPositionRow()),
            },
        });

        const addEvent = buildApprovedEvent({
            intentAction: OrderIntentActionEnum.ADD,
            tradeSide: PositionSideEnum.LONG,
            clampedExit: buildMomentumClampedExit({ stopLossPrice: new Money('50600') }), // SL above fill
        });
        // Fill at SL would be wrong-side for OPEN, but ADD must not apply D2
        const fillSummary = buildFillSummary('50600');

        await (service as any).openOrAddPositionAndAttachProtection(addEvent, {}, { fillSummary }, Date.now());

        expect(syntheticCloseSpy).not.toHaveBeenCalled();
    });

    it('arm is NOT called on ADD path (ADR 0007 §3 + ADR 0008 — arm is OPEN-only)', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
            positions: {
                createOpen: jest.fn(),
                save: jest.fn().mockResolvedValue(buildPositionRow()),
                findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(buildPositionRow()),
            },
        });

        const addEvent = buildApprovedEvent({
            intentAction: OrderIntentActionEnum.ADD,
            tradeSide: PositionSideEnum.LONG,
        });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(addEvent, {}, { fillSummary }, Date.now());

        expect(armSpy).not.toHaveBeenCalled();
    });
});

// ─── FA7: D1 fallback — tpRebaseEligible=true but atrDistance=null ────────────

describe('ExecutionService M38 — FA7: tpRebaseEligible=true with null atrDistance → arm receives frozen TP, no crash', () => {
    it('does not crash and arm receives the frozen TP when atrDistance is null despite tpRebaseEligible=true', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        const frozenTp = new Money('50800');
        const clampedExit = buildMomentumClampedExit({
            takeProfitPrice: frozenTp,
            atrDistance: null, // null — fallback
            tpRebaseEligible: true, // eligible flag still set
        });

        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.LONG,
            clampedExit,
        });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await expect((service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now())).resolves.toBeUndefined();

        expect(armSpy).toHaveBeenCalledTimes(1);
        const armCall = armSpy.mock.calls[0][0];
        // Fallback: frozen TP is used (atrDistance is null → no rebase)
        expect(armCall.takeProfitPrice.toFixed(2)).toBe(frozenTp.toFixed(2));
    });
});

// ─── FA8: Boundary — atrDistance=0 → rebased TP = fill price exactly ─────────

describe('ExecutionService M38 — FA8: atrDistance=0 → rebased TP equals fill price exactly', () => {
    it('arm receives takeProfitPrice equal to fill when atrDistance is 0 (LONG)', async () => {
        const armSpy = jest.fn();
        const service = buildService({
            localProtectiveMonitor: { arm: armSpy, disarm: jest.fn() },
        });

        const clampedExit = buildMomentumClampedExit({
            atrDistance: new Money('0'),
            tpRebaseEligible: true,
        });

        const event = buildApprovedEvent({
            tradeSide: PositionSideEnum.LONG,
            clampedExit,
        });
        const fillSummary = buildFillSummary(FILL_PRICE);

        await (service as any).openOrAddPositionAndAttachProtection(event, {}, { fillSummary }, Date.now());

        expect(armSpy).toHaveBeenCalledTimes(1);
        const armCall = armSpy.mock.calls[0][0];
        // rebased TP = fill + 0 = fill
        expect(armCall.takeProfitPrice.toFixed(8)).toBe(new Money(FILL_PRICE).toFixed(8));
    });
});

// ─── FA9: PENDING_OPEN closing fill — in-memory promote before save ───────────

describe('ExecutionService M38 — FA9: PENDING_OPEN closing fill promotes in-memory state before save', () => {
    it('applyReduceFillToPosition saves OPEN (not PENDING_OPEN) and reaches CLOSING transition', async () => {
        const closeQty = '225';
        const pendingRow = {
            ...buildPositionRow(112, PositionSideEnum.LONG),
            state: PositionStateEnum.PENDING_OPEN,
            qty: new Money(closeQty),
        };

        const transitionMock = jest.fn().mockImplementation(async (_id: number, toState: PositionStateEnum) => {
            if (toState === PositionStateEnum.OPEN) {
                return { ...pendingRow, state: PositionStateEnum.OPEN };
            }

            if (toState === PositionStateEnum.CLOSING) {
                return { ...pendingRow, state: PositionStateEnum.CLOSING, qty: new Money(0) };
            }

            return pendingRow;
        });

        const finalizeMock = jest.fn().mockResolvedValue({
            ...pendingRow,
            state: PositionStateEnum.CLOSED,
            qty: new Money(0),
            exitReason: ExitReasonEnum.TIME_STOP,
        });

        const savedRows: Array<{ state: PositionStateEnum }> = [];
        const service = buildService({
            positions: {
                createOpen: jest.fn(),
                findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(pendingRow),
                save: jest.fn().mockImplementation(async (row: typeof pendingRow) => {
                    savedRows.push({ state: row.state });

                    return row;
                }),
            },
            positionService: {
                transition: transitionMock,
                adjustQty: jest.fn(),
                finalizeRealizedPnl: finalizeMock,
            },
        });

        const event = buildApprovedEvent({
            intentAction: OrderIntentActionEnum.CLOSE,
            tradeSide: PositionSideEnum.LONG,
        });
        (event.intent as { exitReason?: ExitReasonEnum }).exitReason = ExitReasonEnum.TIME_STOP;

        const fillSummary = {
            filledQty: new Money(closeQty),
            avgFillPrice: new Money(FILL_PRICE),
            filledNotional: new Money(new Money(FILL_PRICE).times(new Money(closeQty)).toFixed(8)),
            feeTotal: new Money('0.5'),
        };

        await (service as any).applyReduceFillToPosition(event, { clientOrderId: 'coid-close', exchangeOrderId: 'eoid-close', state: 'FILLED' }, fillSummary);

        expect(savedRows).toHaveLength(1);
        expect(savedRows[0].state).toBe(PositionStateEnum.OPEN);

        const closingCall = transitionMock.mock.calls.find(([, toState]) => toState === PositionStateEnum.CLOSING);
        expect(closingCall).toBeDefined();
        expect(finalizeMock).toHaveBeenCalled();
    });
});

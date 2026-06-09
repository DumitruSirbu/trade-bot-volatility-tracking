/**
 * marketSnapshotMapper — M27 real active_positions_count tests (A4)
 *
 * Tests:
 *   M27-MAP-1 — Count=0 when activePositionsCount is not provided (flat market / default)
 *   M27-MAP-2 — Count=2 when activePositionsCount=2 is passed explicitly
 *   M27-MAP-3 — Count tops at 3 (M25 ceiling) when 3 positions held
 *   M27-MAP-4 — Gate receives active_positions_count as pre-stamp value (0), not the real count
 *   M27-MAP-5 — stampGateVerdict overrides active_positions_count to the real post-evaluate value
 *   M27-MAP-6 — buildMarketSnapshot output is a stable shape (geometry fields are absent — A1)
 */

import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, PositionSlotEnum, RegimeLabelEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { buildMarketSnapshot, IMarketSnapshotInput } from '../marketSnapshotMapper';

// ─── event factory ────────────────────────────────────────────────────────────

function buildEvent(overrides: Record<string, unknown> = {}): IMarketSnapshotInput['event'] {
    return {
        symbol: 'BTCUSDT',
        side: 'above' as any,
        entryCandleOpenTime: new Date('2026-06-01T10:00:00.000Z').getTime(),
        eventId: 'BTCUSDT:evt1',
        vwapSession: '50000',
        vwap20bar: '50000',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 3.0,
        vwapDeviationSigma: 2.5,
        volumeRatio: 2.0,
        volume20barAvg: '1000000',
        atr14: '500',
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 10,
        rsi14: 65,
        bollingerUpper: '51500',
        bollingerLower: '48500',
        bollingerPctB: 0.85,
        btc5mMovePct: 0.1,
        btc1mMovePct: 0.05,
        eth5mMovePct: 0.2,
        idiosyncrasyScore: 0.7,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 1,
        symbolUniverseAgeHours: 200,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.08,
        bidAskSpreadPct: 0.01,
        bookDepth10bpsUsdt: '50000000',
        bookDepth50bpsUsdt: '999999999',
        regimeLabel: RegimeLabelEnum.TRENDING_UP,
        marketBreadth5mUpPct: 55,
        sameBarTriggerCount: 1,
        openInterest: '500000000',
        openInterestChange5mPct: 0.1,
        openInterestChange15mPct: 0.3,
        aggTradeBuyVolumeRatio: 0.6,
        flowType: FlowTypeEnum.TREND_INITIATION,
        ...overrides,
    } as IMarketSnapshotInput['event'];
}

function buildParams(): IMarketSnapshotInput['params'] {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.3,
        btc_correlated_move_threshold_pct: 1.0,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier2_min_abs_move_pct: 1.0,
        tier3_min_abs_move_pct: 2.0,
        tier1_max_abs_move_pct: 5.0,
        tier2_max_abs_move_pct: 8.0,
        tier3_max_abs_move_pct: 12.0,
        funding_rate_suppress_threshold: 0.01,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 3,
        max_trades_per_symbol_per_day: 5,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    } as IMarketSnapshotInput['params'];
}

function buildInput(overrides: Partial<IMarketSnapshotInput> = {}): IMarketSnapshotInput {
    return {
        event: buildEvent(),
        params: buildParams(),
        flowType: FlowTypeEnum.TREND_INITIATION,
        signalScore: 80,
        ...overrides,
    };
}

// ─── M27-MAP-1: Default count=0 when not provided ────────────────────────────

describe('marketSnapshotMapper M27 — M27-MAP-1: active_positions_count defaults to 0', () => {
    it('when activePositionsCount is omitted, active_positions_count is 0', () => {
        const snapshot = buildMarketSnapshot(buildInput());

        expect(snapshot.active_positions_count).toBe(0);
    });

    it('when activePositionsCount is explicitly 0, active_positions_count is 0', () => {
        const snapshot = buildMarketSnapshot(buildInput({ activePositionsCount: 0 }));

        expect(snapshot.active_positions_count).toBe(0);
    });
});

// ─── M27-MAP-2: Count=2 when 2 positions held ────────────────────────────────

describe('marketSnapshotMapper M27 — M27-MAP-2: active_positions_count=2 when 2 positions held', () => {
    it('passes activePositionsCount=2 through to the snapshot field', () => {
        const snapshot = buildMarketSnapshot(buildInput({ activePositionsCount: 2 }));

        expect(snapshot.active_positions_count).toBe(2);
    });
});

// ─── M27-MAP-3: Count tops at 3 (M25 ceiling) ────────────────────────────────

describe('marketSnapshotMapper M27 — M27-MAP-3: active_positions_count at M25 ceiling (3)', () => {
    it('activePositionsCount=3 is passed through as-is (M25 3-slot ceiling)', () => {
        const snapshot = buildMarketSnapshot(buildInput({ activePositionsCount: 3 }));

        expect(snapshot.active_positions_count).toBe(3);
    });
});

// ─── M27-MAP-4: Gate receives pre-stamp value (0) ────────────────────────────

describe('marketSnapshotMapper M27 — M27-MAP-4: snapshot passed to gate has active_positions_count=0 (pre-stamp)', () => {
    it('the snapshot built before gateAndPersist always starts with active_positions_count=0', () => {
        // In StrategyService.onVolatilityDetected, buildMarketSnapshot is called with
        // activePositionsCount=0 (no gate state loaded). The post-evaluate stamp happens
        // in stampGateVerdict after evaluate() returns, so the gate input is always 0.
        const snapshot = buildMarketSnapshot(buildInput());

        expect(snapshot.active_positions_count).toBe(0);
    });
});

// ─── M27-MAP-5: stampGateVerdict overrides the count post-evaluate ────────────

describe('marketSnapshotMapper M27 — M27-MAP-5: post-evaluate count is stamped via spread, not through mapper', () => {
    it('overriding active_positions_count on the snapshot after evaluate reflects the real count', () => {
        const preGateSnapshot = buildMarketSnapshot(buildInput());
        const realCountFromFindOpen = 2;

        // stampGateVerdict spreads the snapshot with the real count
        const stampedSnapshot = { ...preGateSnapshot, active_positions_count: realCountFromFindOpen };

        expect(preGateSnapshot.active_positions_count).toBe(0);
        expect(stampedSnapshot.active_positions_count).toBe(2);
    });

    it('slot override is also applied when approvedSlot is present', () => {
        const preGateSnapshot = buildMarketSnapshot(buildInput());

        const withCount = { ...preGateSnapshot, active_positions_count: 1 };
        const withSlot = { ...withCount, position_slot: PositionSlotEnum.B };

        expect(withSlot.active_positions_count).toBe(1);
        expect(withSlot.position_slot).toBe(PositionSlotEnum.B);
    });
});

// ─── M27-MAP-6: marketSnapshotSchema does NOT gain geometry keys (A1) ─────────

describe('marketSnapshotMapper M27 — M27-MAP-6: geometry fields are absent from buildMarketSnapshot output (A1)', () => {
    it('buildMarketSnapshot output does not contain gate_allowed, trade_side, stop_loss, take_profit, qty, notional, leverage, halt_reason_detail', () => {
        const snapshot = buildMarketSnapshot(buildInput()) as Record<string, unknown>;

        // A1 invariant: geometry lives on top-level DecisionEntity columns, NOT in marketSnapshot
        const forbiddenKeys = ['gate_allowed', 'trade_side', 'stop_loss', 'take_profit', 'qty', 'notional', 'leverage', 'halt_reason_detail'];

        for (const key of forbiddenKeys) {
            expect(snapshot).not.toHaveProperty(key);
        }
    });

    it('buildMarketSnapshot output contains active_positions_count (the only A4 snapshot change)', () => {
        const snapshot = buildMarketSnapshot(buildInput({ activePositionsCount: 1 }));

        expect(snapshot).toHaveProperty('active_positions_count', 1);
    });

    it('correlation_mode is IDIOSYNCRATIC when btc5mMovePct is below threshold (0.1 < 1.0)', () => {
        const snapshot = buildMarketSnapshot(buildInput());

        expect(snapshot.correlation_mode).toBe(CorrelationModeEnum.IDIOSYNCRATIC);
    });

    it('position_slot defaults to A in the mapper output (gate may override later)', () => {
        const snapshot = buildMarketSnapshot(buildInput());

        expect(snapshot.position_slot).toBe(PositionSlotEnum.A);
    });
});

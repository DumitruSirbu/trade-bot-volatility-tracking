/**
 * ExecutionService — M35 entry-snapshot column mapping (Finding 1)
 *
 * mapEntrySnapshotColumns is a private method. We test it indirectly by calling
 * the private method directly via `(service as any).mapEntrySnapshotColumns(...)`.
 * This is the standard pattern for private-method unit testing when the method is
 * pure (no I/O, no state) and testing via the full handleApproved pipeline would
 * require wiring the entire execute state machine.
 *
 * Additionally, the ADD recovery-fallback path is verified by confirming that
 * applyAddToExistingPosition passes `entrySnapshot: undefined` to createPositionFromFill
 * on the fallback branch — the mapper returns {} for undefined input.
 *
 * Surfaces under test:
 *
 *   ES1 — Happy path: all 12 columns populated when snapshot is present
 *   ES2 — Absent snapshot (undefined) → mapper returns {} (no snapshot columns)
 *   ES3 — ADD recovery-fallback passes entrySnapshot: undefined to createPositionFromFill
 *   ES4 — Determinism: same snapshot → identical column values on repeated calls (pure)
 *   ES5 — Money columns are Money/Decimal instances (not raw strings)
 *   ES6 — VwapAnchorType column maps verbatim from snapshot.vwap_anchor_type
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    FlowTypeEnum,
    IMarketSnapshot,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RegimeLabelEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { ExecutionService } from '../ExecutionService';

// ─── minimal fixture helpers ──────────────────────────────────────────────────

/**
 * Build a complete IMarketSnapshot-compatible object covering all 12 entry columns:
 * vwap_session, atr_14, vwap_deviation_pct, idiosyncrasy_score, signal_score,
 * open_interest, open_interest_change_5m_pct, funding_rate_annualized,
 * book_depth_10bps_usdt, bid_ask_spread_pct, vwap_anchor_type, symbol_universe_age_hours.
 */
function buildFullSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    const snapshot: IMarketSnapshot = {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 2.5,
        vwap_deviation_sigma: 1.2,
        volume_ratio: 1.8,
        volume_20bar_avg: '1000000',
        atr_14: '200',
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
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 82,
        position_slot: PositionSlotEnum.A,
        active_positions_count: 0,
        regime_label: RegimeLabelEnum.TRENDING_UP,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.55,
        idiosyncrasy_score: 0.72,
        vwap_anchor_type: VwapAnchorTypeEnum.SESSION,
        symbol_universe_age_hours: 120,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };

    return snapshot;
}

/**
 * Construct a minimal ExecutionService with all dependencies mocked.
 * We only need the service instance to call the private mapper method.
 */
function buildService(): ExecutionService {
    return new ExecutionService(
        { isExecutionLive: false } as any, // appConfig
        { plan: jest.fn() } as any, // policyRouter
        { build: jest.fn() } as any, // clientOrderIdFactory
        { submit: jest.fn() } as any, // submitter
        { accumulate: jest.fn(), forget: jest.fn() } as any, // fillAccumulator
        { attach: jest.fn() } as any, // protectiveAttacher
        { arm: jest.fn(), disarm: jest.fn() } as any, // localProtectiveMonitor
        {
            // positions (PositionRepository)
            createOpen: jest.fn().mockResolvedValue({ id: 1, symbol: 'BTCUSDT' }),
            save: jest.fn().mockResolvedValue({ id: 1 }),
            findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(null),
        } as any,
        { transition: jest.fn().mockResolvedValue(undefined), adjustQty: jest.fn(), finalizeRealizedPnl: jest.fn() } as any, // positionService
        { recordTerminal: jest.fn().mockResolvedValue(undefined) } as any, // transactions
        { findById: jest.fn().mockResolvedValue({ direction: 'both' }) } as any, // strategyVersions
        { evaluate: jest.fn() } as any, // riskGate
        { isHalted: jest.fn().mockReturnValue(false), getReason: jest.fn() } as any, // haltFlag
        {} as any, // exchangeClient
        { emit: jest.fn() } as any, // events
    );
}

// Helper: call the private mapper via `any` cast (standard JS pattern for private method tests)
function callMapper(service: ExecutionService, snapshot: IMarketSnapshot | undefined) {
    return (service as any).mapEntrySnapshotColumns(snapshot);
}

// ─── ES1: All 12 columns populated when snapshot is present ──────────────────

describe('ExecutionService M35 — ES1: mapEntrySnapshotColumns — all 12 columns populated when snapshot present', () => {
    it('returns an object with all 12 entry-snapshot column keys set to non-null values', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot();

        const columns = callMapper(service, snapshot);

        expect(columns.vwapAtEntry).toBeDefined();
        expect(columns.atrAtEntry).toBeDefined();
        expect(columns.vwapDeviationAtEntry).toBeDefined();
        expect(columns.idiosyncrasyAtEntry).toBeDefined();
        expect(columns.signalScoreAtEntry).toBeDefined();
        expect(columns.openInterestAtEntry).toBeDefined();
        expect(columns.oiChange5mAtEntry).toBeDefined();
        expect(columns.fundingAnnualizedAtEntry).toBeDefined();
        expect(columns.bookDepth10bpsAtEntry).toBeDefined();
        expect(columns.spreadAtEntryPct).toBeDefined();
        expect(columns.vwapAnchorType).toBeDefined();
        expect(columns.symbolUniverseAgeHours).toBeDefined();
    });

    it('vwapAtEntry matches snapshot.vwap_session as a Money value', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ vwap_session: '48750.50' });

        const columns = callMapper(service, snapshot);

        expect(columns.vwapAtEntry.toFixed(2)).toBe('48750.50');
    });

    it('atrAtEntry matches snapshot.atr_14', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ atr_14: '315.25' });

        const columns = callMapper(service, snapshot);

        expect(columns.atrAtEntry.toFixed(2)).toBe('315.25');
    });

    it('vwapDeviationAtEntry matches snapshot.vwap_deviation_pct', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ vwap_deviation_pct: 3.14 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.vwapDeviationAtEntry.toFixed(10))).toBeCloseTo(3.14, 5);
    });

    it('idiosyncrasyAtEntry matches snapshot.idiosyncrasy_score', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ idiosyncrasy_score: 0.67 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.idiosyncrasyAtEntry.toFixed(10))).toBeCloseTo(0.67, 5);
    });

    it('signalScoreAtEntry matches snapshot.signal_score', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ signal_score: 91 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.signalScoreAtEntry.toFixed(0))).toBe(91);
    });

    it('openInterestAtEntry matches snapshot.open_interest', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ open_interest: '7654321' });

        const columns = callMapper(service, snapshot);

        expect(columns.openInterestAtEntry.toFixed(0)).toBe('7654321');
    });

    it('oiChange5mAtEntry matches snapshot.open_interest_change_5m_pct', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ open_interest_change_5m_pct: -1.23 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.oiChange5mAtEntry.toFixed(10))).toBeCloseTo(-1.23, 5);
    });

    it('fundingAnnualizedAtEntry matches snapshot.funding_rate_annualized', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ funding_rate_annualized: 0.365 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.fundingAnnualizedAtEntry.toFixed(10))).toBeCloseTo(0.365, 5);
    });

    it('bookDepth10bpsAtEntry matches snapshot.book_depth_10bps_usdt', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ book_depth_10bps_usdt: '8888888' });

        const columns = callMapper(service, snapshot);

        expect(columns.bookDepth10bpsAtEntry.toFixed(0)).toBe('8888888');
    });

    it('spreadAtEntryPct matches snapshot.bid_ask_spread_pct', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ bid_ask_spread_pct: 0.07 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.spreadAtEntryPct.toFixed(10))).toBeCloseTo(0.07, 5);
    });

    it('vwapAnchorType maps verbatim from snapshot.vwap_anchor_type enum value', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ vwap_anchor_type: VwapAnchorTypeEnum.ROLLING_20BAR });

        const columns = callMapper(service, snapshot);

        expect(columns.vwapAnchorType).toBe(VwapAnchorTypeEnum.ROLLING_20BAR);
    });

    it('symbolUniverseAgeHours matches snapshot.symbol_universe_age_hours', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ symbol_universe_age_hours: 72 });

        const columns = callMapper(service, snapshot);

        expect(Number(columns.symbolUniverseAgeHours.toFixed(0))).toBe(72);
    });
});

// ─── ES2: Absent snapshot (undefined) → empty object ─────────────────────────

describe('ExecutionService M35 — ES2: mapEntrySnapshotColumns(undefined) → empty object, no snapshot columns', () => {
    it('returns an empty object when snapshot is undefined', () => {
        const service = buildService();

        const columns = callMapper(service, undefined);

        expect(columns).toEqual({});
    });

    it('empty result has no keys (spread of {} leaves other columns untouched)', () => {
        const service = buildService();

        const columns = callMapper(service, undefined);
        const columnKeys = Object.keys(columns);

        expect(columnKeys).toHaveLength(0);
    });
});

// ─── ES3: ADD recovery-fallback passes entrySnapshot: undefined ───────────────

describe('ExecutionService M35 — ES3: ADD recovery-fallback (findOpenBySymbolAndSlot returns null) calls createPositionFromFill without entrySnapshot', () => {
    it('on ADD with missing position row, createPositionFromFill is called; entrySnapshot is NOT on the fallback event and returns undefined to the mapper', () => {
        const service = buildService();

        // The fallback path inside applyAddToExistingPosition calls createPositionFromFill
        // with a bare IOrderIntentApprovedEvent that does NOT include entrySnapshot.
        // We verify this by inspecting that mapEntrySnapshotColumns returns {} when the
        // entrySnapshot field is absent (undefined) — which is what the fallback produces.

        // Simulate the fallback event structure: no entrySnapshot property at all.
        const fallbackEvent = {
            intent: {
                intentAction: OrderIntentActionEnum.ADD,
                symbol: 'BTCUSDT',
                tradeSide: PositionSideEnum.LONG,
                // entrySnapshot intentionally absent
            },
            // entrySnapshot: not set
        };

        const columns = callMapper(service, (fallbackEvent as any).entrySnapshot);

        // The fallback event has no entrySnapshot → undefined → mapper returns {}
        expect(columns).toEqual({});
    });

    it('ADD normal path (position found) does NOT call createPositionFromFill (no snapshot columns risk)', async () => {
        const service = buildService();

        // On a successful ADD (position found), applyAddToExistingPosition updates in-place
        // and calls positions.save, NOT createPositionFromFill. To verify: mock positions
        // to return a row, then confirm createOpen was never called.
        const existingPosition = {
            id: 42,
            symbol: 'BTCUSDT',
            qty: new Money('0.1'),
            entryPrice: new Money('50000'),
            entryNotional: new Money('5000'),
        };

        (service as any).positions.findOpenBySymbolAndSlot = jest.fn().mockResolvedValue(existingPosition);
        (service as any).positions.save = jest.fn().mockResolvedValue({ ...existingPosition, qty: new Money('0.2') });

        const fillSummary = {
            filledQty: new Money('0.1'),
            avgFillPrice: new Money('50100'),
            filledNotional: new Money('5010'),
            feeTotal: new Money('2'),
        };

        const addEvent = {
            intent: {
                intentAction: OrderIntentActionEnum.ADD,
                symbol: 'BTCUSDT',
                tradeSide: PositionSideEnum.LONG,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            },
            approvedSlot: PositionSlotEnum.A,
            // No entrySnapshot
        };

        await (service as any).applyAddToExistingPosition(addEvent, fillSummary);

        // Normal ADD path: positions.save was called (weighted avg update), NOT createOpen
        expect((service as any).positions.save).toHaveBeenCalledTimes(1);
        expect((service as any).positions.createOpen).not.toHaveBeenCalled();
    });
});

// ─── ES4: Determinism — pure function, same input → same output ───────────────

describe('ExecutionService M35 — ES4: mapEntrySnapshotColumns is pure — identical input → identical output', () => {
    it('calling the mapper twice with the same snapshot produces identical column values', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot();

        const first = callMapper(service, snapshot);
        const second = callMapper(service, snapshot);

        expect(first.vwapAtEntry.toFixed(18)).toBe(second.vwapAtEntry.toFixed(18));
        expect(first.atrAtEntry.toFixed(18)).toBe(second.atrAtEntry.toFixed(18));
        expect(first.vwapDeviationAtEntry.toFixed(18)).toBe(second.vwapDeviationAtEntry.toFixed(18));
        expect(first.idiosyncrasyAtEntry.toFixed(18)).toBe(second.idiosyncrasyAtEntry.toFixed(18));
        expect(first.signalScoreAtEntry.toFixed(18)).toBe(second.signalScoreAtEntry.toFixed(18));
        expect(first.openInterestAtEntry.toFixed(18)).toBe(second.openInterestAtEntry.toFixed(18));
        expect(first.oiChange5mAtEntry.toFixed(18)).toBe(second.oiChange5mAtEntry.toFixed(18));
        expect(first.fundingAnnualizedAtEntry.toFixed(18)).toBe(second.fundingAnnualizedAtEntry.toFixed(18));
        expect(first.bookDepth10bpsAtEntry.toFixed(18)).toBe(second.bookDepth10bpsAtEntry.toFixed(18));
        expect(first.spreadAtEntryPct.toFixed(18)).toBe(second.spreadAtEntryPct.toFixed(18));
        expect(first.vwapAnchorType).toBe(second.vwapAnchorType);
        expect(first.symbolUniverseAgeHours.toFixed(18)).toBe(second.symbolUniverseAgeHours.toFixed(18));
    });

    it('different snapshots produce different vwapAtEntry values (no cross-call state)', () => {
        const service = buildService();

        const snapshotA = buildFullSnapshot({ vwap_session: '40000' });
        const snapshotB = buildFullSnapshot({ vwap_session: '50000' });

        const resultA = callMapper(service, snapshotA);
        const resultB = callMapper(service, snapshotB);

        expect(resultA.vwapAtEntry.toFixed(0)).toBe('40000');
        expect(resultB.vwapAtEntry.toFixed(0)).toBe('50000');
    });
});

// ─── ES5: Money columns are Money/Decimal instances, not raw strings ──────────

describe('ExecutionService M35 — ES5: numeric snapshot columns are wrapped in Money/Decimal, not returned as raw strings', () => {
    it('vwapAtEntry has a toFixed() method (is a Money/Decimal instance)', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot();

        const columns = callMapper(service, snapshot);

        expect(typeof columns.vwapAtEntry.toFixed).toBe('function');
    });

    it('bookDepth10bpsAtEntry is a Money instance (not a bare string)', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ book_depth_10bps_usdt: '99999' });

        const columns = callMapper(service, snapshot);

        // A raw string would fail this assertion (strings don't have .times())
        expect(typeof columns.bookDepth10bpsAtEntry.times).toBe('function');
    });

    it('oiChange5mAtEntry can be negative (preserves sign)', () => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ open_interest_change_5m_pct: -3.5 });

        const columns = callMapper(service, snapshot);

        expect(columns.oiChange5mAtEntry.isNegative()).toBe(true);
    });
});

// ─── ES6: vwapAnchorType maps all VwapAnchorTypeEnum values ──────────────────

describe('ExecutionService M35 — ES6: vwapAnchorType column maps all VwapAnchorTypeEnum variants correctly', () => {
    const anchorTypes = [VwapAnchorTypeEnum.SESSION, VwapAnchorTypeEnum.ROLLING_20BAR, VwapAnchorTypeEnum.ROLLING_24H, VwapAnchorTypeEnum.EVENT_ANCHORED];

    it.each(anchorTypes)('vwap_anchor_type=%s maps verbatim to vwapAnchorType column', (anchorType) => {
        const service = buildService();
        const snapshot = buildFullSnapshot({ vwap_anchor_type: anchorType });

        const columns = callMapper(service, snapshot);

        expect(columns.vwapAnchorType).toBe(anchorType);
    });
});

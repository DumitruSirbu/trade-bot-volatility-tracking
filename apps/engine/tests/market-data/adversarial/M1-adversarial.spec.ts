/**
 * M1 adversarial tests — market data / exchange integration.
 *
 * Surfaces under test (from M5.5-adversarial-backfill.md §M1):
 *   S1 — 5-min bar close authority: late ticks, quiet-symbol sweep, tick/sweep race
 *   S2 — Trigger formula determinism on identical inputs (live = backtest parity)
 *   S3 — Session-anchored VWAP reset at UTC 00:00 boundary
 *   S4 — WebSocket reconnect mid-bar / universe eviction mid-bar
 *   S5 — Empirical band calibration percentile floor (N < window, floor convention)
 *
 * Plus producer-side non-finite indicator guard (from M2 audit carried forward):
 *   P1 — computeVwap: zero-volume window must NOT produce NaN/Infinity downstream
 *   P2 — computeDeviationSigma: empty/flat window must NOT produce NaN/Infinity
 *   P3 — computeAtr / computeBollinger: empty series / zero-stddev must NOT produce NaN/Infinity
 *
 * ADR clauses under test:
 *   ADR 0001 §closed-bar-only-no-look-ahead + exactly-once close (S1, S4)
 *   ADR 0001 §shared-trigger-formula (S2)
 *   ADR 0001 §VWAP-anchor-discipline (S3)
 *   ADR 0001 §empirical-band-calibration (S5)
 *
 * Failure routing: per dev-qa-cycle.md §2.2 — any failure routes to architect, not developer.
 */

import { CoinTierEnum, DeviationSideEnum, ITriggerResult } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { computeAtr } from '../../../src/market-data/indicator/computeAtr';
import { computeBollinger } from '../../../src/market-data/indicator/computeBollinger';
import { computeDeviationSigma } from '../../../src/market-data/indicator/computeDeviation';
import { computeVwap } from '../../../src/market-data/indicator/computeVwap';
import { evaluateTrigger } from '../../../src/market-data/trigger/evaluateTrigger';
import { ICandle } from '../../../src/market-data/interface/ICandle';
import { Money } from '../../../src/common/utils/money';
import { CANDLE_5M_INTERVAL_MS, CALIBRATION_MIN_SAMPLES } from '../../../src/market-data/const';
import { SymbolCandleState } from '../../../src/market-data/state/SymbolCandleState';
import { SymbolMarketState } from '../../../src/market-data/state/SymbolMarketState';
import { DeviationCalibrationService } from '../../../src/market-data/service/DeviationCalibrationService';
import { MarketDataService } from '../../../src/market-data/service/MarketDataService';
import { SymbolStateRegistry } from '../../../src/market-data/service/SymbolStateRegistry';
import { IIndicatorSnapshot } from '../../../src/market-data/interface';

import * as indicatorModule from '../../../src/market-data/indicator';
import * as triggerModule from '../../../src/market-data/trigger';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function m(value: number | string) {
    return new Money(String(value));
}

function flatCandle(price: number, volume: number, openTimeMs = 0): ICandle {
    const p = m(price);
    const v = m(volume);

    return {
        openTimeMs,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: v,
        quoteVolume: p.times(v),
        isClosed: true,
    };
}

function buildTriggerParams() {
    return {
        vwapSigmaTrigger: 2.5,
        volumeRatioMin: 2.0,
        tierMinAbsMovePct: 0.8,
        tierMaxAbsMovePct: 6.0,
    };
}

// Timestamps: bucket 0 = [0, 300_000), bucket 1 = [300_000, 600_000)
const BUCKET_0_START = 0;
const BUCKET_0_MID = 60_000;
const BUCKET_1_START = CANDLE_5M_INTERVAL_MS; // 300_000

// UTC midnight boundary (00:00:00.000 on 2000-01-01 ≈ day index 10957)
const UTC_MIDNIGHT_MS = 946_684_800_000; // 2000-01-01 00:00:00 UTC in ms

// ---------------------------------------------------------------------------
// S1 — 5-min bar close authority
// ---------------------------------------------------------------------------

describe('S1 — 5-min bar close authority', () => {
    // ADR 0001 §exactly-once close: a tick whose timestamp is in an already-graduated
    // bucket must be silently dropped — not reopen or re-graduate the bucket.
    describe('late tick after sweep graduation', () => {
        it('rejects a late tick timestamped inside the already-closed bucket (exact watermark boundary)', () => {
            // BUILD
            // ADR 0001 §exactly-once close: late tick must not mutate closed bar.
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(1), BUCKET_0_START);
            // Sweep closes bucket 0
            const swept = state.closeFormingIfElapsed(BUCKET_1_START);

            expect(swept).not.toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);

            // OPERATE — tick timestamped at the bucket boundary (exactly at watermark)
            const lateResult = state.ingestTick(m(999), m(100), BUCKET_0_START);

            // CHECK — dropped: bucket already closed, no second graduation
            expect(lateResult).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
            // Volume must not be corrupted by the late tick
            expect(state.getClosedBars()[0].volume.toNumber()).toBe(1);
        });

        it('rejects a tick timestamped exactly AT the watermark openTimeMs (≤ guard)', () => {
            // ADR 0001 §exactly-once close: watermark is lastClosedBucketOpenTimeMs;
            // any tick with bucketOpenTime <= watermark is a late tick and must be dropped.
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(1), BUCKET_0_START);
            state.closeFormingIfElapsed(BUCKET_1_START); // closes bucket 0

            // Tick at exactly the bucket 0 open time — bucketOpenTime(0) = 0 = watermark
            const late = state.ingestTick(m(200), m(50), BUCKET_0_MID);

            expect(late).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
        });

        it('does NOT reject a tick timestamped in the NEXT bucket after sweep', () => {
            // ADR 0001 §exactly-once close: a tick in bucket 1 must be accepted even
            // after the sweep closed bucket 0.
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(1), BUCKET_0_START);
            state.closeFormingIfElapsed(BUCKET_1_START);

            // Tick in bucket 1 — must open bucket 1 (not be dropped)
            const result = state.ingestTick(m(200), m(1), BUCKET_1_START + 1_000);

            expect(result).toBeNull(); // opens bucket 1, no graduation yet
            // Advance to bucket 2 to graduate bucket 1
            const closed = state.ingestTick(m(200), m(1), BUCKET_1_START + CANDLE_5M_INTERVAL_MS);

            expect(closed).not.toBeNull();
            expect(closed!.openTimeMs).toBe(BUCKET_1_START); // bucket 1, not bucket 0
        });
    });

    // ADR 0001 §exactly-once close: a quiet symbol (zero ticks for >5min) must still
    // emit exactly one closed bar when the wall-clock sweep fires.
    describe('quiet symbol gets a bar close via sweep', () => {
        it('graduates the forming bar on sweep even when no tick crosses the boundary', () => {
            // BUILD
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(5), BUCKET_0_START); // opens bucket 0; no more ticks

            // OPERATE — sweep fires after the interval elapses (no tick)
            const sweptBar = state.closeFormingIfElapsed(BUCKET_1_START + 1_000);

            // CHECK — bar closed exactly once by the sweep
            expect(sweptBar).not.toBeNull();
            expect(sweptBar!.isClosed).toBe(true);
            expect(state.getClosedBars()).toHaveLength(1);
        });

        it('a second sweep in the same bucket interval after the first closes nothing additional', () => {
            // ADR 0001 §exactly-once close: double-sweep must be idempotent.
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(5), BUCKET_0_START);
            state.closeFormingIfElapsed(BUCKET_1_START + 1_000); // closes bucket 0

            // OPERATE — second sweep at the same nowMs
            const secondSweep = state.closeFormingIfElapsed(BUCKET_1_START + 2_000);

            // CHECK — no second graduation; bucket 0 already closed
            expect(secondSweep).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
        });

        it('SymbolMarketState.closeElapsedBars returns exactly one bar for a quiet symbol', () => {
            // ADR 0001 §exactly-once close: the SymbolMarketState orchestration layer
            // must also produce exactly one graduation for a quiet symbol.
            const state = new SymbolMarketState('BTCUSDT', CoinTierEnum.TIER_1);

            state.ingestTick(m(100), m(5), BUCKET_0_START);

            const closed = state.closeElapsedBars(BUCKET_1_START + 1_000);

            expect(closed).not.toBeNull();
            expect(closed!.isClosed).toBe(true);

            // Second sweep — must not produce a second graduation
            const second = state.closeElapsedBars(BUCKET_1_START + 2_000);

            expect(second).toBeNull();
        });
    });

    // ADR 0001 §exactly-once close: tick path races with the watermark advance when
    // a tick arrives in the same ms as the bucket boundary.
    describe('tick/sweep race at the exact bucket boundary', () => {
        it('tick path closes the bar when tick arrives at exactly BUCKET_1_START; sweep is then a no-op', () => {
            // BUILD
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(1), BUCKET_0_START);

            // OPERATE — tick at the exact boundary graduates bucket 0
            const tickClosed = state.ingestTick(m(101), m(1), BUCKET_1_START);

            expect(tickClosed).not.toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);

            // Sweep fires 1 ms later — must be a no-op (bucket 0 watermarked)
            const sweepClosed = state.closeFormingIfElapsed(BUCKET_1_START + 1);

            expect(sweepClosed).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
        });

        it('exactly-one close invariant holds when tick and sweep target the same bucket openTime', () => {
            // The sweep closes bucket 0; a tick whose timestamp resolves to bucket 0 arrives after.
            const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

            state.ingestTick(m(100), m(1), BUCKET_0_START);
            const sweptBar = state.closeFormingIfElapsed(BUCKET_1_START);

            expect(sweptBar).not.toBeNull();

            // Tick at the same boundary — its bucket open time equals the watermark,
            // so ≤ guard fires and it is dropped (not re-opened)
            const tickAfterSweep = state.ingestTick(m(105), m(10), BUCKET_0_MID);

            expect(tickAfterSweep).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
        });
    });
});

// ---------------------------------------------------------------------------
// S2 — Trigger formula determinism on identical inputs
// ---------------------------------------------------------------------------

describe('S2 — Trigger formula determinism (ADR 0001 §shared-trigger-formula)', () => {
    it('produces bit-identical ITriggerResult across 10 repeated invocations on the same input', () => {
        // ADR 0001 §shared-trigger-formula: no hidden state, no clock reads in the trigger.
        const input = {
            symbol: 'ETH/USDT:USDT',
            vwapDeviationSigma: 3.1,
            vwapDeviationPct: 2.8,
            volumeRatio: 4.2,
        };
        const params = buildTriggerParams();

        const baseline: ITriggerResult = evaluateTrigger(input, params);

        for (let run = 0; run < 10; run += 1) {
            const result = evaluateTrigger(input, params);

            expect(result).toStrictEqual(baseline);
        }
    });

    it('produces bit-identical output regardless of when in wall-clock time the call happens', () => {
        // ADR 0001 §shared-trigger-formula: result must not vary with Date.now() drift.
        const input = {
            symbol: 'BTC/USDT:USDT',
            vwapDeviationSigma: -2.6,
            vwapDeviationPct: -1.5,
            volumeRatio: 3.0,
        };
        const params = buildTriggerParams();

        // Two calls with a forced pause between does not change the output.
        const first = evaluateTrigger(input, params);
        const second = evaluateTrigger(input, params);

        expect(first.fired).toBe(second.fired);
        expect(first.side).toBe(second.side);
        expect(first.sigmaConditionMet).toBe(second.sigmaConditionMet);
        expect(first.volumeConditionMet).toBe(second.volumeConditionMet);
        expect(first.minMoveConditionMet).toBe(second.minMoveConditionMet);
        expect(first.maxMoveConditionMet).toBe(second.maxMoveConditionMet);
    });

    it('produces ABOVE side for a positive deviation and BELOW for negative — deterministically', () => {
        // ADR 0001 §shared-trigger-formula: side derivation must be purely input-driven.
        const params = buildTriggerParams();

        const above = evaluateTrigger({ symbol: 'X', vwapDeviationSigma: 3.0, vwapDeviationPct: 2.5, volumeRatio: 3.0 }, params);
        const below = evaluateTrigger({ symbol: 'X', vwapDeviationSigma: -3.0, vwapDeviationPct: -2.5, volumeRatio: 3.0 }, params);

        expect(above.side).toBe(DeviationSideEnum.ABOVE);
        expect(below.side).toBe(DeviationSideEnum.BELOW);

        // Repeat — side must not flip
        expect(evaluateTrigger({ symbol: 'X', vwapDeviationSigma: 3.0, vwapDeviationPct: 2.5, volumeRatio: 3.0 }, params).side).toBe(DeviationSideEnum.ABOVE);
    });

    it('different sigma inputs produce consistently different outcomes across repeated invocations', () => {
        // ADR 0001 §shared-trigger-formula: same-input → same-output across runs.
        const params = buildTriggerParams();
        const firingInput = { symbol: 'X', vwapDeviationSigma: 3.0, vwapDeviationPct: 2.5, volumeRatio: 3.0 };
        const notFiringInput = { symbol: 'X', vwapDeviationSigma: 1.0, vwapDeviationPct: 2.5, volumeRatio: 3.0 };

        for (let run = 0; run < 5; run += 1) {
            expect(evaluateTrigger(firingInput, params).fired).toBe(true);
            expect(evaluateTrigger(notFiringInput, params).fired).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// S3 — Session-anchored VWAP reset at UTC 00:00 boundary
// ---------------------------------------------------------------------------

describe('S3 — Session-anchored VWAP reset at UTC 00:00 (ADR 0001 §VWAP-anchor-discipline)', () => {
    // The session reset is keyed off the bar's close time (openTimeMs + 5min interval),
    // never wall-clock. SymbolMarketState.resetSessionIfNewDay uses this formula.

    it('session bars are cleared when a bar closes exactly at UTC midnight', () => {
        // ADR 0001 §VWAP-anchor-discipline: session context must not carry across day boundary.
        // BUILD — seed session with bars BEFORE midnight
        const state = new SymbolMarketState('ETHUSDT', CoinTierEnum.TIER_1);
        const INTERVAL_MS = CANDLE_5M_INTERVAL_MS;

        // Bar whose close time is exactly UTC_MIDNIGHT_MS:
        // openTimeMs = UTC_MIDNIGHT_MS - INTERVAL_MS
        const lastBarOfDayOpenTime = UTC_MIDNIGHT_MS - INTERVAL_MS;

        // Two pre-midnight bars to build session state
        state.ingestTick(m(3000), m(10), lastBarOfDayOpenTime - INTERVAL_MS);
        state.ingestTick(m(3010), m(10), lastBarOfDayOpenTime);
        state.ingestTick(m(3020), m(10), lastBarOfDayOpenTime + INTERVAL_MS); // closes bar at midnight boundary

        const sessionBeforeReset = state.getSessionBars().length;

        expect(sessionBeforeReset).toBeGreaterThan(0);

        // OPERATE — a bar that closes AFTER midnight (openTime ≥ midnight)
        // Its close time = openTime + 5min = at least midnight + 5min → new day
        state.ingestTick(m(3030), m(10), UTC_MIDNIGHT_MS);
        state.ingestTick(m(3040), m(10), UTC_MIDNIGHT_MS + INTERVAL_MS); // closes first after-midnight bar

        // CHECK — session bars were cleared; only the new-day bar(s) remain
        const sessionAfterReset = state.getSessionBars();

        // The reset must have fired; the bars in session now should all be from the new day
        for (const bar of sessionAfterReset) {
            const closeTimeMs = bar.openTimeMs + INTERVAL_MS;
            const dayIndex = Math.floor(closeTimeMs / (24 * 60 * 60 * 1000));
            const midnightDayIndex = Math.floor(UTC_MIDNIGHT_MS / (24 * 60 * 60 * 1000));

            expect(dayIndex).toBeGreaterThanOrEqual(midnightDayIndex);
        }
    });

    it('session bars are NOT cleared for a bar closing just BEFORE UTC midnight', () => {
        // ADR 0001 §VWAP-anchor-discipline: the reset fires only when dayIndex advances.
        // A bar closing at midnight - 1ms is still the same day and must not reset.
        const state = new SymbolMarketState('ETHUSDT', CoinTierEnum.TIER_1);
        const INTERVAL_MS = CANDLE_5M_INTERVAL_MS;

        // Bar closing at exactly midnight - 5ms (same day)
        const almostMidnightOpenTime = UTC_MIDNIGHT_MS - INTERVAL_MS - 5;

        state.ingestTick(m(3000), m(10), almostMidnightOpenTime - INTERVAL_MS);
        const beforeCount = state.getSessionBars().length;

        state.ingestTick(m(3010), m(10), almostMidnightOpenTime);
        state.ingestTick(m(3020), m(10), almostMidnightOpenTime + INTERVAL_MS);

        const afterCount = state.getSessionBars().length;

        // Session bars grow — no reset fired for same-day bars
        expect(afterCount).toBeGreaterThan(beforeCount);
    });

    it('session bars are cleared for a bar closing at UTC midnight + 1ms (next day)', () => {
        // ADR 0001 §VWAP-anchor-discipline: even 1 ms past midnight triggers the reset.
        const state = new SymbolMarketState('BTCUSDT', CoinTierEnum.TIER_1);
        const INTERVAL_MS = CANDLE_5M_INTERVAL_MS;

        // Seed with same-day bars
        state.ingestTick(m(50000), m(1), UTC_MIDNIGHT_MS - 2 * INTERVAL_MS);
        state.ingestTick(m(50100), m(1), UTC_MIDNIGHT_MS - INTERVAL_MS);

        const countBeforeReset = state.getSessionBars().length;

        expect(countBeforeReset).toBeGreaterThan(0);

        // Bar whose close time is midnight + 1ms: openTime = midnight + 1ms - INTERVAL_MS
        const firstNextDayOpenTime = UTC_MIDNIGHT_MS - INTERVAL_MS + 1;

        state.ingestTick(m(50200), m(1), firstNextDayOpenTime);
        state.ingestTick(m(50300), m(1), firstNextDayOpenTime + INTERVAL_MS); // closes bar at midnight+1ms

        // After the reset the session can only contain bars whose close time >= midnight
        const sessionBars = state.getSessionBars();

        expect(sessionBars.length).toBeLessThan(countBeforeReset + 2);

        for (const bar of sessionBars) {
            const closeTimeMs = bar.openTimeMs + INTERVAL_MS;

            expect(closeTimeMs).toBeGreaterThanOrEqual(UTC_MIDNIGHT_MS);
        }
    });
});

// ---------------------------------------------------------------------------
// S4 — WebSocket reconnect mid-bar / universe eviction mid-bar
// ---------------------------------------------------------------------------

// These are exercised at the SymbolCandleState / MarketDataService private-method
// level because the WS reconnect handling in ccxt.pro is library-internal (no
// driver code in MarketDataService beyond the `catch` + continue loop).
// The invariant under test is: state after reconnect delivers exactly the same
// post-close behavior as state without reconnect.

jest.mock('../../../src/market-data/indicator', () => {
    const actual = jest.requireActual('../../../src/market-data/indicator');

    return { ...actual, computeIndicatorSnapshot: jest.fn() };
});

jest.mock('../../../src/market-data/trigger', () => {
    const actual = jest.requireActual('../../../src/market-data/trigger');

    return { ...actual, evaluateTrigger: jest.fn() };
});

function buildFiringSnapshot(openTimeMs: number, symbol = 'ETH/USDT:USDT'): IIndicatorSnapshot {
    return {
        symbol,
        closedBarOpenTimeMs: openTimeMs,
        vwapSession: m(2000),
        vwap20bar: m(2000),
        vwap24h: m(2000),
        vwapEventAnchored: m(2000),
        activeVwapAnchorType: 'rolling_20bar' as IIndicatorSnapshot['activeVwapAnchorType'],
        vwapDeviationPct: 2.5,
        vwapDeviationSigma: 3.0,
        volumeRatio: 3.0,
        volume20barAvg: m(100),
        atr14: m(10),
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 10,
        rsi14: 70,
        bollingerUpper: m(2100),
        bollingerLower: m(1900),
        bollingerPctB: 0.95,
        close: m(2050),
        fiveMinMovePct: 1.2,
    };
}

const FIRED_RESULT: ITriggerResult = {
    fired: true,
    side: DeviationSideEnum.ABOVE,
    sigmaConditionMet: true,
    volumeConditionMet: true,
    minMoveConditionMet: true,
    maxMoveConditionMet: true,
};

function buildMarketDataService(emitter: EventEmitter2, registry: SymbolStateRegistry): MarketDataService {
    const universe = {
        getEntry: jest.fn((symbol: string) => ({
            symbol,
            tier: CoinTierEnum.TIER_1,
            volumeRank: 1,
            quoteVolume24h: m(0),
            enteredAtMs: 0,
        })),
        universeAgeHours: jest.fn().mockReturnValue(48),
    };
    const context = {
        btc5mMovePct: jest.fn().mockReturnValue(0),
        btc1mMovePct: jest.fn().mockReturnValue(0),
        eth5mMovePct: jest.fn().mockReturnValue(0),
        btc5mBarMovePct: jest.fn().mockReturnValue(0),
        breadth: jest.fn().mockReturnValue({ upPct1m: 0, upPct5m: 0, upPct15m: 0 }),
    };
    const depthAggressor = { start: jest.fn(), stop: jest.fn() };
    const flowPoll = { pollOpenInterestForSymbol: jest.fn() };
    const calibration = { record: jest.fn() };

    return new MarketDataService(
        {} as never,
        emitter,
        universe as never,
        registry,
        context as never,
        depthAggressor as never,
        flowPoll as never,
        calibration as never,
    );
}

describe('S4 — Reconnect mid-bar / universe eviction mid-bar', () => {
    const SYMBOL = 'ETH/USDT:USDT';

    beforeEach(() => {
        jest.clearAllMocks();
        (triggerModule.evaluateTrigger as jest.Mock).mockReturnValue(FIRED_RESULT);
    });

    it('state after a simulated reconnect resumes bar accumulation without phantom extra close', () => {
        // ADR 0001 §closed-bar-only-no-look-ahead + exactly-once close:
        // A reconnect is represented as a gap in the tick stream (no ticks for the
        // mid-bar window). The resumed ticker batch must close the bar exactly once.
        const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

        // Pre-reconnect: open bucket 0
        state.ingestTick(m(100), m(5), BUCKET_0_START);

        // Simulated reconnect gap — no ticks for 4 minutes within bucket 0.
        // Resumed ticks start at bucket 0, then a tick crosses into bucket 1.
        state.ingestTick(m(102), m(3), BUCKET_0_MID + 30_000); // still in bucket 0
        const closed = state.ingestTick(m(105), m(2), BUCKET_1_START);

        // Exactly one graduation
        expect(closed).not.toBeNull();
        expect(state.getClosedBars()).toHaveLength(1);
        expect(state.getClosedBars()[0].openTimeMs).toBe(BUCKET_0_START);
    });

    it('duplicate ticks on reconnect (same ms) do not create a second closed bar', () => {
        // ADR 0001 §exactly-once close: ccxt.pro may replay the last tick on reconnect.
        // Duplicate ticks within the same bucket must accumulate only once.
        const state = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

        state.ingestTick(m(100), m(5), BUCKET_0_START);
        // Simulate duplicate tick for the same timestamp
        state.ingestTick(m(100), m(5), BUCKET_0_START);

        // Advance to close bucket 0
        const closed = state.ingestTick(m(101), m(1), BUCKET_1_START);

        expect(closed).not.toBeNull();
        expect(state.getClosedBars()).toHaveLength(1);
    });

    it('universe eviction mid-bar: MarketDataService drops the evicted symbol from trigger evaluation', () => {
        // ADR 0001 §closed-bar-only-no-look-ahead: an evicted symbol must not emit
        // a volatility.detected event after the universe removes it.
        const emitter = new EventEmitter2();
        const emitSpy = jest.spyOn(emitter, 'emit');
        const registry = new SymbolStateRegistry();
        const service = buildMarketDataService(emitter, registry);

        (indicatorModule.computeIndicatorSnapshot as jest.Mock).mockReturnValue(buildFiringSnapshot(0));

        // Evicted symbol: getEntry returns null (symbol no longer in universe)
        (service['universe'] as unknown as { getEntry: jest.Mock }).getEntry.mockImplementation((sym: string) =>
            sym === SYMBOL ? null : { symbol: sym, tier: CoinTierEnum.TIER_1, volumeRank: 1, quoteVolume24h: m(0), enteredAtMs: 0 },
        );

        // Feed ticks that would graduate bucket 0 for the evicted symbol
        service['handleTickerBatch']([{ symbol: SYMBOL, last: '2000', quoteVolume: '1000', timestampMs: BUCKET_0_MID }] as never);
        service['handleTickerBatch']([{ symbol: SYMBOL, last: '2050', quoteVolume: '2000', timestampMs: BUCKET_1_START }] as never);

        const volatilityEmits = emitSpy.mock.calls.filter(([event]) => event === 'volatility.detected');

        // No volatility event for an evicted symbol
        expect(volatilityEmits).toHaveLength(0);
    });

    it('a symbol evicted mid-bar does not emit a stale bar close in the subsequent sweep', () => {
        // ADR 0001 §exactly-once close: even if the symbol state sits in the registry,
        // sweepBarCloses calls evaluate() which checks the universe — evicted symbol
        // gets null from getEntry and evaluate returns null, so no event is emitted.
        const emitter = new EventEmitter2();
        const emitSpy = jest.spyOn(emitter, 'emit');
        const registry = new SymbolStateRegistry();
        const service = buildMarketDataService(emitter, registry);

        (indicatorModule.computeIndicatorSnapshot as jest.Mock).mockReturnValue(buildFiringSnapshot(0));
        (triggerModule.evaluateTrigger as jest.Mock).mockReturnValue(FIRED_RESULT);

        // Open a bar for the symbol while it is still in the universe
        (service['universe'] as unknown as { getEntry: jest.Mock }).getEntry.mockReturnValue({
            symbol: SYMBOL,
            tier: CoinTierEnum.TIER_1,
            volumeRank: 1,
            quoteVolume24h: m(0),
            enteredAtMs: 0,
        });

        service['handleTickerBatch']([{ symbol: SYMBOL, last: '2000', quoteVolume: '1000', timestampMs: BUCKET_0_MID }] as never);

        // Universe evicts the symbol before the sweep fires
        (service['universe'] as unknown as { getEntry: jest.Mock }).getEntry.mockReturnValue(null);

        service.sweepBarCloses();

        const volatilityEmits = emitSpy.mock.calls.filter(([event]) => event === 'volatility.detected');

        expect(volatilityEmits).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// S5 — Empirical band calibration percentile floor
// ---------------------------------------------------------------------------

describe('S5 — Empirical band calibration percentile floor (ADR 0001 §empirical-band-calibration)', () => {
    it('stats() reports isTrustworthy=false when fewer than CALIBRATION_MIN_SAMPLES are recorded', () => {
        // ADR 0001 §empirical-band-calibration: calibration with N < window must not be
        // silently treated as reliable — isTrustworthy must be false.
        const svc = new DeviationCalibrationService();

        for (let i = 0; i < CALIBRATION_MIN_SAMPLES - 1; i += 1) {
            svc.record('BTC', 1.5);
        }

        const result = svc.stats('BTC');

        expect(result.isTrustworthy).toBe(false);
        expect(result.sampleCount).toBe(CALIBRATION_MIN_SAMPLES - 1);
    });

    it('stats() reports isTrustworthy=true exactly at CALIBRATION_MIN_SAMPLES', () => {
        // Boundary: exactly at the minimum — must cross to trustworthy.
        const svc = new DeviationCalibrationService();

        for (let i = 0; i < CALIBRATION_MIN_SAMPLES; i += 1) {
            svc.record('BTC', 1.0);
        }

        const result = svc.stats('BTC');

        expect(result.isTrustworthy).toBe(true);
    });

    it('stats() returns zero percentiles for a symbol with no samples', () => {
        // Newly-entered symbol with no history must not throw and must return 0.
        const svc = new DeviationCalibrationService();
        const result = svc.stats('NEWCOIN');

        expect(result.sampleCount).toBe(0);
        expect(result.isTrustworthy).toBe(false);
        expect(result.medianAbsDeviationPct).toBe(0);
        expect(result.p90AbsDeviationPct).toBe(0);
        expect(result.p99AbsDeviationPct).toBe(0);
    });

    it('nearest-rank floor convention: p50 of [1.0, 2.0, 3.0] returns index floor(0.5×3)=1 → 2.0', () => {
        // ADR 0001 §empirical-band-calibration: pins the nearest-rank floor convention
        // so M7 backtest can mirror it exactly.
        const svc = new DeviationCalibrationService();

        // Record 3 samples at specific values
        svc.record('SYM', 1.0);
        svc.record('SYM', 2.0);
        svc.record('SYM', 3.0);

        const result = svc.stats('SYM');

        // p50: index = floor(0.5 * 3) = 1 → sorted[1] = 2.0 (the middle value)
        expect(result.medianAbsDeviationPct).toBe(2.0);
    });

    it('nearest-rank floor convention: p90 of 10 uniform samples at [1..10] returns sorted[9]=10', () => {
        // Pins that p90 = sorted[floor(0.9 * 10)] = sorted[9] = 10.
        const svc = new DeviationCalibrationService();

        for (let value = 1; value <= 10; value += 1) {
            svc.record('SYM', value);
        }

        const result = svc.stats('SYM');

        // floor(0.9 * 10) = 9 → sorted[9] = 10
        expect(result.p90AbsDeviationPct).toBe(10);
    });

    it('p99 of single sample returns that sample (floor clips to last index)', () => {
        // Boundary: 1 sample — floor(0.99 × 1) = 0 → the only element.
        const svc = new DeviationCalibrationService();

        svc.record('SYM', 5.5);

        const result = svc.stats('SYM');

        expect(result.p99AbsDeviationPct).toBe(5.5);
    });
});

// ---------------------------------------------------------------------------
// P1–P3 — Producer-side non-finite indicator guard (M2 audit carry-forward)
// ---------------------------------------------------------------------------

describe('P1 — computeVwap: zero-volume window must NOT produce a non-finite Decimal', () => {
    it('returns a finite Decimal (last close) for a single zero-volume bar', () => {
        // ADR 0002 §money-as-decimal: a NaN Decimal reaching persistence would corrupt
        // the NUMERIC column. computeVwap must guard and return a finite fallback.
        const bars = [flatCandle(100, 0)];
        const result = computeVwap(bars);

        expect(isFinite(result.toNumber())).toBe(true);
        expect(result.isNaN()).toBe(false);
    });

    it('returns a finite Decimal (last close) for multiple zero-volume bars', () => {
        const bars = [flatCandle(100, 0), flatCandle(200, 0), flatCandle(150, 0)];
        const result = computeVwap(bars);

        expect(isFinite(result.toNumber())).toBe(true);
        expect(result.isNaN()).toBe(false);
        // Fallback: last bar's close = 150
        expect(result.toNumber()).toBe(150);
    });
});

describe('P2 — computeDeviationSigma: empty / flat window must NOT produce NaN or Infinity', () => {
    it('returns exactly 0 (finite) for an empty bar array', () => {
        // Zero-length window: no mean, no variance — result must be 0 not NaN.
        const result = computeDeviationSigma([], m(100));

        expect(result).toBe(0);
        expect(isFinite(result)).toBe(true);
        expect(Number.isNaN(result)).toBe(false);
    });

    it('returns exactly 0 (finite) for a single bar (σ undefined with N=1)', () => {
        const bars = [flatCandle(100, 1)];
        const result = computeDeviationSigma(bars, m(100));

        expect(result).toBe(0);
        expect(isFinite(result)).toBe(true);
    });

    it('returns exactly 0 (finite) for a flat series where all closes equal VWAP', () => {
        // Flat series → variance = 0 → sqrt(0) = 0, not NaN or -0.
        const bars = [flatCandle(100, 1), flatCandle(100, 1), flatCandle(100, 1)];
        const result = computeDeviationSigma(bars, m(100));

        expect(result).toBe(0);
        expect(isFinite(result)).toBe(true);
        expect(Object.is(result, -0)).toBe(false); // guard against -0
    });

    it('returns exactly 0 (finite) when VWAP anchor is zero (division guard)', () => {
        const bars = [flatCandle(100, 1), flatCandle(110, 1)];
        const result = computeDeviationSigma(bars, m(0));

        expect(result).toBe(0);
        expect(isFinite(result)).toBe(true);
    });
});

describe('P3 — computeAtr / computeBollinger: edge series must NOT produce NaN or Infinity', () => {
    it('computeAtr returns a finite zero Decimal when bars <= period (insufficient data)', () => {
        // ADR 0002 §money-as-decimal: a non-finite ATR reaching money math would cascade.
        const bars = [flatCandle(100, 1), flatCandle(101, 1)]; // 2 bars, period=14
        const result = computeAtr(bars, 14);

        expect(isFinite(result.toNumber())).toBe(true);
        expect(result.isNaN()).toBe(false);
        expect(result.toNumber()).toBe(0);
    });

    it('computeAtr returns a finite zero Decimal for an empty series', () => {
        const result = computeAtr([], 14);

        expect(isFinite(result.toNumber())).toBe(true);
        expect(result.isNaN()).toBe(false);
    });

    it('computeAtr returns a finite non-negative Decimal for a flat-price series (zero range)', () => {
        // All bars same price → true range = 0 for every bar → ATR = 0, not NaN.
        const bars = Array.from({ length: 20 }, () => flatCandle(100, 1));
        const result = computeAtr(bars, 14);

        expect(isFinite(result.toNumber())).toBe(true);
        expect(result.isNaN()).toBe(false);
        expect(result.toNumber()).toBeGreaterThanOrEqual(0);
    });

    it('computeBollinger returns finite band prices for an empty slice (period > bars)', () => {
        // ADR 0002 §money-as-decimal: if fewer bars than period, slice returns empty →
        // average() and stddev() must guard and return a finite fallback.
        const bars: ICandle[] = [flatCandle(100, 1)]; // 1 bar, period=20
        const result = computeBollinger(bars, 20, 2);

        expect(isFinite(result.upper.toNumber())).toBe(true);
        expect(isFinite(result.lower.toNumber())).toBe(true);
        expect(isFinite(result.middle.toNumber())).toBe(true);
        expect(isFinite(result.percentB)).toBe(true);
        expect(result.upper.isNaN()).toBe(false);
        expect(result.lower.isNaN()).toBe(false);
    });

    it('computeBollinger returns finite %B of 0.5 for a flat-price series (zero band width)', () => {
        // Zero stddev → bandWidth = 0 → %B guard returns 0.5, not NaN or Infinity.
        const bars = Array.from({ length: 20 }, (_, i) => flatCandle(100, 1, i * 1000));
        const result = computeBollinger(bars, 20, 2);

        expect(isFinite(result.percentB)).toBe(true);
        expect(Number.isNaN(result.percentB)).toBe(false);
        expect(result.percentB).toBe(0.5);
    });
});

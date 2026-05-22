import { SymbolCandleState } from '../../../src/market-data/state/SymbolCandleState';
import { Money } from '../../../src/common/utils/money';
import { CLOSED_BAR_WINDOW_SIZE, CANDLE_5M_INTERVAL_MS } from '../../../src/market-data/const';

const INTERVAL_MS = CANDLE_5M_INTERVAL_MS; // 300 000 ms

function m(value: number) {
    return new Money(String(value));
}

// Timestamps within the same 5-minute bucket (bucket 0 = 0..299 999 ms).
const T0 = 0;
const T1 = 60_000; // still inside bucket 0
const T2 = 120_000; // still inside bucket 0
const T_NEXT = 300_000; // first tick of bucket 1 → closes bucket 0

describe('SymbolCandleState', () => {
    describe('initial state', () => {
        it('returns an empty closed-bar array before any tick arrives', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            expect(state.getClosedBars()).toHaveLength(0);
        });

        it('returns null for the latest closed bar before any tick arrives', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            expect(state.getLatestClosedBar()).toBeNull();
        });
    });

    describe('first tick — starts forming candle, produces no closed bar', () => {
        it('returns null from ingestTick on the very first tick', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            const closed = state.ingestTick(m(100), m(5), T0);

            expect(closed).toBeNull();
        });

        it('keeps closed bars empty after the first tick', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(5), T0);

            expect(state.getClosedBars()).toHaveLength(0);
        });
    });

    describe('OHLCV accumulation within a single interval', () => {
        it('tracks the high as the maximum price seen', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(115), m(1), T1);
            state.ingestTick(m(108), m(1), T2);

            // Advance into the next bucket to graduate the forming candle.
            const closed = state.ingestTick(m(110), m(1), T_NEXT) as NonNullable<ReturnType<SymbolCandleState['ingestTick']>>;

            expect(closed).not.toBeNull();
            expect(closed.high.toNumber()).toBe(115);
        });

        it('tracks the low as the minimum price seen', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(90), m(1), T1);
            state.ingestTick(m(105), m(1), T2);

            const closed = state.ingestTick(m(100), m(1), T_NEXT) as NonNullable<ReturnType<SymbolCandleState['ingestTick']>>;

            expect(closed.low.toNumber()).toBe(90);
        });

        it('sets the open to the first tick price in the interval', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(110), m(1), T1);

            const closed = state.ingestTick(m(105), m(1), T_NEXT) as NonNullable<ReturnType<SymbolCandleState['ingestTick']>>;

            expect(closed.open.toNumber()).toBe(100);
        });

        it('sets the close to the last tick price before the interval boundary', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(110), m(1), T1);
            state.ingestTick(m(108), m(1), T2);

            const closed = state.ingestTick(m(120), m(1), T_NEXT) as NonNullable<ReturnType<SymbolCandleState['ingestTick']>>;

            expect(closed.close.toNumber()).toBe(108);
        });

        it('accumulates volume across all ticks in the interval', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(3), T0);
            state.ingestTick(m(102), m(7), T1);

            const closed = state.ingestTick(m(101), m(1), T_NEXT) as NonNullable<ReturnType<SymbolCandleState['ingestTick']>>;

            expect(closed.volume.toNumber()).toBe(10);
        });
    });

    describe('graduation — candle closes at the interval boundary', () => {
        it('returns a non-null closed bar when the first tick of a new interval arrives', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);

            const closed = state.ingestTick(m(101), m(1), T_NEXT);

            expect(closed).not.toBeNull();
        });

        it('marks the graduated bar as isClosed = true', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);

            const closed = state.ingestTick(m(101), m(1), T_NEXT)!;

            expect(closed.isClosed).toBe(true);
        });

        it('adds the graduated bar to getClosedBars()', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(101), m(1), T_NEXT);

            expect(state.getClosedBars()).toHaveLength(1);
        });

        it('records the correct openTimeMs for the graduated bar', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(101), m(1), T_NEXT);

            const closedBars = state.getClosedBars();

            expect(closedBars[0].openTimeMs).toBe(0); // bucket 0 opens at ms 0
        });

        it('does NOT include the forming candle in getClosedBars() (look-ahead prevention)', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(101), m(1), T1); // still within the same bucket

            // Only the forming candle exists — no closed bars yet.
            expect(state.getClosedBars()).toHaveLength(0);
        });
    });

    describe('rolling window cap', () => {
        it('never holds more than CLOSED_BAR_WINDOW_SIZE closed bars', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            // Feed CLOSED_BAR_WINDOW_SIZE + 2 intervals to overflow the window.
            for (let i = 0; i <= CLOSED_BAR_WINDOW_SIZE + 1; i++) {
                const tickTimeMs = i * INTERVAL_MS;
                state.ingestTick(m(100), m(1), tickTimeMs);
            }

            expect(state.getClosedBars().length).toBeLessThanOrEqual(CLOSED_BAR_WINDOW_SIZE);
        });

        it('retains the most recent bars when the window overflows', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            const totalIntervals = CLOSED_BAR_WINDOW_SIZE + 5;

            for (let i = 0; i <= totalIntervals; i++) {
                const price = 100 + i; // Each interval has a unique price for identification.
                state.ingestTick(m(price), m(1), i * INTERVAL_MS);
            }

            const bars = state.getClosedBars();
            const latestBar = bars[bars.length - 1];

            // The last closed bar's open price should be from the most recent graduated interval.
            expect(latestBar.open.toNumber()).toBeGreaterThan(100);
        });
    });

    describe('multiple consecutive graduations', () => {
        it('accumulates two closed bars across two distinct intervals', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0); // bucket 0 starts
            state.ingestTick(m(101), m(1), T_NEXT); // bucket 0 closes, bucket 1 starts
            state.ingestTick(m(102), m(1), T_NEXT + INTERVAL_MS); // bucket 1 closes, bucket 2 starts

            expect(state.getClosedBars()).toHaveLength(2);
        });

        it('getLatestClosedBar returns the most recently graduated bar', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.ingestTick(m(200), m(1), T_NEXT);
            state.ingestTick(m(300), m(1), T_NEXT + INTERVAL_MS);

            const latest = state.getLatestClosedBar();

            expect(latest).not.toBeNull();
            expect(latest!.open.toNumber()).toBe(200);
        });
    });

    // The wall-clock sweep and exchange-event ticks run on different clocks; a late
    // tick can land in an already-closed bucket. The bucket watermark must prevent
    // any bucket from being opened or graduated twice (would corrupt σ/volume windows).
    describe('double-close guard on late ticks', () => {
        it('does not re-open or re-close a bucket the sweep already graduated', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0); // open bucket 0

            const sweptBar = state.closeFormingIfElapsed(T_NEXT); // sweep closes bucket 0

            expect(sweptBar).not.toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);

            // Late tick whose exchange timestamp still falls inside bucket 0.
            const lateBar = state.ingestTick(m(105), m(1), T2);

            expect(lateBar).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1); // still exactly one
        });

        it('does not double-graduate bucket 0 when a bucket-1 tick follows a late bucket-0 tick', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            state.closeFormingIfElapsed(T_NEXT); // sweep graduates bucket 0
            state.ingestTick(m(105), m(1), T2); // late bucket-0 tick — dropped

            // Next tick belongs to bucket 1; must open bucket 1, not re-graduate bucket 0.
            state.ingestTick(m(110), m(1), T_NEXT);
            const closed = state.ingestTick(m(120), m(1), T_NEXT + INTERVAL_MS); // closes bucket 1

            expect(closed).not.toBeNull();
            expect(closed!.openTimeMs).toBe(T_NEXT); // bucket 1, never a duplicate bucket 0
            const openTimes = state.getClosedBars().map((bar) => bar.openTimeMs);
            expect(openTimes).toEqual([0, T_NEXT]); // no duplicate openTimeMs
        });

        it('sweep is a no-op when the tick path already closed the bucket', () => {
            const state = new SymbolCandleState(INTERVAL_MS);

            state.ingestTick(m(100), m(1), T0);
            const tickClosed = state.ingestTick(m(101), m(1), T_NEXT); // tick graduates bucket 0

            expect(tickClosed).not.toBeNull();

            // A sweep arriving in bucket 1 must not graduate the forming bucket-1 candle
            // as a second copy of bucket 0, nor re-close bucket 0.
            const sweepClosed = state.closeFormingIfElapsed(T_NEXT + 1_000);

            expect(sweepClosed).toBeNull();
            expect(state.getClosedBars()).toHaveLength(1);
        });
    });
});

/**
 * Unit tests for SymbolMarketState — 1-second OHLCV tick bucketing (M2 round-1).
 *
 * Covers:
 *   - Multiple ticks within one second collapse into a single bucket (O/H/L/C + summed volume)
 *   - A tick crossing the next second closes the prior bucket
 *   - The closed bucket's ts equals the bucket-start (floored) ms
 *   - Intra-candle spike reconstruction from a sequence of 1s buckets
 *   - Wall-clock sweep path (closeElapsedTickBucket) also closes the forming bucket
 *   - drainClosedTickBuckets empties the buffer after each drain
 */

import { SymbolMarketState } from '../../../src/market-data/state/SymbolMarketState';
import { Money } from '../../../src/common/utils/money';
import { CoinTierEnum } from '@bot/shared';
import { TICK_AGGREGATE_BUCKET_MS } from '../../../src/market-data/const';

function m(value: number | string) {
    return new Money(String(value));
}

function makeState(): SymbolMarketState {
    return new SymbolMarketState('BTCUSDT', CoinTierEnum.TIER_1);
}

// Base second boundary: 1 000 000 ms = exactly one second-aligned ms.
const BASE_S = 1_000_000;

describe('SymbolMarketState — 1-second tick bucketing', () => {
    describe('single bucket — multiple ticks within the same second', () => {
        it('produces no closed bucket while ticks stay within the same second', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(110), m(2), BASE_S + 200);
            state.ingestTick(m(105), m(3), BASE_S + 800);

            expect(state.drainClosedTickBuckets()).toHaveLength(0);
        });

        it('collapses multiple ticks into one bucket with the correct open (first tick price)', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(110), m(2), BASE_S + 400);
            // trigger close by crossing into the next second
            state.ingestTick(m(108), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(1);
            expect(buckets[0]!.open.toNumber()).toBe(100);
        });

        it('collapses multiple ticks into one bucket with the correct high (max price)', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(120), m(2), BASE_S + 400);
            state.ingestTick(m(105), m(1), BASE_S + 700);
            state.ingestTick(m(99), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[0]!.high.toNumber()).toBe(120);
        });

        it('collapses multiple ticks into one bucket with the correct low (min price)', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(85), m(2), BASE_S + 300);
            state.ingestTick(m(105), m(1), BASE_S + 600);
            state.ingestTick(m(99), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[0]!.low.toNumber()).toBe(85);
        });

        it('collapses multiple ticks into one bucket with the correct close (last tick price)', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(110), m(2), BASE_S + 300);
            state.ingestTick(m(107), m(1), BASE_S + 700);
            // trigger close
            state.ingestTick(m(99), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[0]!.close.toNumber()).toBe(107);
        });

        it('sums volume across all ticks in the same second', () => {
            const state = makeState();

            state.ingestTick(m(100), m(3), BASE_S);
            state.ingestTick(m(110), m(7), BASE_S + 200);
            state.ingestTick(m(105), m(5), BASE_S + 800);
            state.ingestTick(m(99), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[0]!.volume.toNumber()).toBe(15);
        });
    });

    describe('bucket boundary — tick crossing the next second closes the prior bucket', () => {
        it('closes exactly one bucket when the tick crosses into the next second', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(101), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(1);
        });

        it('the closed bucket ts equals the floored bucket-start ms, not the raw tick ms', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S + 500); // mid-second
            state.ingestTick(m(101), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS + 100);

            const buckets = state.drainClosedTickBuckets();

            // ts must be the start of the second, not the raw 500ms-offset tick time.
            expect(buckets[0]!.tsMs).toBe(BASE_S);
        });

        it('produces two closed buckets when three distinct seconds are crossed', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(101), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);
            state.ingestTick(m(102), m(1), BASE_S + 2 * TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(2);
        });

        it('each closed bucket ts is offset by exactly TICK_AGGREGATE_BUCKET_MS from the previous', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(101), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);
            state.ingestTick(m(102), m(1), BASE_S + 2 * TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[1]!.tsMs - buckets[0]!.tsMs).toBe(TICK_AGGREGATE_BUCKET_MS);
        });
    });

    describe('wall-clock sweep path — closeElapsedTickBucket', () => {
        it('closes the forming bucket when nowMs has passed the bucket boundary', () => {
            const state = makeState();

            state.ingestTick(m(100), m(5), BASE_S);
            state.closeElapsedTickBucket(BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(1);
            expect(buckets[0]!.tsMs).toBe(BASE_S);
        });

        it('is a no-op when called while the bucket has not yet elapsed', () => {
            const state = makeState();

            state.ingestTick(m(100), m(5), BASE_S);
            state.closeElapsedTickBucket(BASE_S + 500); // still within the same second

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(0);
        });

        it('is a no-op when there is no forming bucket', () => {
            const state = makeState();

            state.closeElapsedTickBucket(BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(0);
        });

        it('preserves OHLCV of the forming bucket when closed by the sweep', () => {
            const state = makeState();

            state.ingestTick(m(200), m(10), BASE_S);
            state.ingestTick(m(250), m(5), BASE_S + 600);
            state.closeElapsedTickBucket(BASE_S + TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            expect(buckets[0]!.open.toNumber()).toBe(200);
            expect(buckets[0]!.high.toNumber()).toBe(250);
            expect(buckets[0]!.low.toNumber()).toBe(200);
            expect(buckets[0]!.close.toNumber()).toBe(250);
            expect(buckets[0]!.volume.toNumber()).toBe(15);
        });
    });

    describe('drain idempotency', () => {
        it('drainClosedTickBuckets returns an empty array when called a second time', () => {
            const state = makeState();

            state.ingestTick(m(100), m(1), BASE_S);
            state.ingestTick(m(101), m(1), BASE_S + TICK_AGGREGATE_BUCKET_MS);

            state.drainClosedTickBuckets(); // first drain empties the buffer

            const second = state.drainClosedTickBuckets();

            expect(second).toHaveLength(0);
        });
    });

    describe('intra-candle spike reconstruction from 1s bucket sequence (M2 DoD)', () => {
        // Sequence: normal → spike high → spike low → recovery → normal
        // Each tick is in its own second so each becomes a distinct 1s bucket.
        const SPIKE_SEQUENCE = [
            { offsetS: 0, price: 29300, volume: 5 },
            { offsetS: 1, price: 29800, volume: 50 }, // spike high
            { offsetS: 2, price: 28900, volume: 30 }, // spike low
            { offsetS: 3, price: 29350, volume: 8 },
            { offsetS: 4, price: 29320, volume: 6 },
        ];

        it('produces one closed bucket per second (5 seconds → 4 closed, 1 forming)', () => {
            const state = makeState();

            for (const tick of SPIKE_SEQUENCE) {
                state.ingestTick(m(tick.price), m(tick.volume), BASE_S + tick.offsetS * TICK_AGGREGATE_BUCKET_MS);
            }

            // 5 ticks in 5 distinct seconds → ticks 1–4 each close the prior bucket;
            // tick 5 (offset=4) opens a forming bucket.  Drain yields 4 closed buckets.
            const buckets = state.drainClosedTickBuckets();

            expect(buckets).toHaveLength(4);
        });

        it('reconstructs the spike high from the closed bucket sequence', () => {
            const state = makeState();

            for (const tick of SPIKE_SEQUENCE) {
                state.ingestTick(m(tick.price), m(tick.volume), BASE_S + tick.offsetS * TICK_AGGREGATE_BUCKET_MS);
            }

            // Flush the forming bucket too so we have all 5 buckets.
            state.closeElapsedTickBucket(BASE_S + SPIKE_SEQUENCE.length * TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();
            const high = buckets.reduce((max, b) => (b.high.greaterThan(max) ? b.high : max), buckets[0]!.high);

            expect(high.toNumber()).toBe(29800);
        });

        it('reconstructs the spike low from the closed bucket sequence', () => {
            const state = makeState();

            for (const tick of SPIKE_SEQUENCE) {
                state.ingestTick(m(tick.price), m(tick.volume), BASE_S + tick.offsetS * TICK_AGGREGATE_BUCKET_MS);
            }

            state.closeElapsedTickBucket(BASE_S + SPIKE_SEQUENCE.length * TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();
            const low = buckets.reduce((min, b) => (b.low.lessThan(min) ? b.low : min), buckets[0]!.low);

            expect(low.toNumber()).toBe(28900);
        });

        it('each bucket ts is the floored second boundary of its tick', () => {
            const state = makeState();

            for (const tick of SPIKE_SEQUENCE) {
                state.ingestTick(m(tick.price), m(tick.volume), BASE_S + tick.offsetS * TICK_AGGREGATE_BUCKET_MS + 237); // non-zero ms offset
            }

            state.closeElapsedTickBucket(BASE_S + SPIKE_SEQUENCE.length * TICK_AGGREGATE_BUCKET_MS);

            const buckets = state.drainClosedTickBuckets();

            for (let i = 0; i < buckets.length; i++) {
                expect(buckets[i]!.tsMs).toBe(BASE_S + i * TICK_AGGREGATE_BUCKET_MS);
            }
        });
    });
});

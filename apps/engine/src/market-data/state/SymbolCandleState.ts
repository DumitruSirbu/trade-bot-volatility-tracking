import { CANDLE_5M_INTERVAL_MS, CLOSED_BAR_WINDOW_SIZE } from '../const';
import { ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';

// Per-symbol candle state for a single timeframe. CRITICAL (ADR §4): the forming
// candle is physically separate from the closed-bar window — indicators and the
// trigger read only `getClosedBars()`, never the forming candle. A forming candle
// only graduates into the closed window when its interval boundary elapses, which
// removes the most common silent backtest-inflation bug (look-ahead) at the source.
export class SymbolCandleState {
    private readonly closedBars: ICandle[] = [];

    private formingCandle: ICandle | null = null;

    // The open time of the most recently graduated bucket. Guards against a bucket
    // being opened or closed twice: the wall-clock sweep and exchange-event ticks run
    // on different clocks (multi-second skew is normal at the sweep cadence), so a
    // late tick can land in an already-closed bucket. We drop any tick whose bucket
    // is at or before this watermark, so a bucket is never re-opened or re-graduated.
    private lastClosedBucketOpenTimeMs: number | null = null;

    constructor(private readonly intervalMs: number = CANDLE_5M_INTERVAL_MS) {}

    // Folds a tick (price, base-asset volume delta) into the forming candle. When the
    // tick crosses into a new interval, the forming candle closes and graduates.
    // Returns the just-closed bar so the caller can recompute indicators, or null.
    ingestTick(price: MoneyValue, volumeDelta: MoneyValue, timestampMs: number): ICandle | null {
        const bucketOpenTimeMs = this.bucketOpenTime(timestampMs);

        // Late tick for an already-closed bucket (sweep/tick clock skew): drop it so a
        // bucket can never be re-opened or graduated a second time with a stale time.
        if (this.lastClosedBucketOpenTimeMs !== null && bucketOpenTimeMs <= this.lastClosedBucketOpenTimeMs) {
            return null;
        }

        if (this.formingCandle === null) {
            this.formingCandle = this.startCandle(price, volumeDelta, bucketOpenTimeMs);

            return null;
        }

        if (bucketOpenTimeMs > this.formingCandle.openTimeMs) {
            const closed = this.graduate(this.formingCandle);

            this.formingCandle = this.startCandle(price, volumeDelta, bucketOpenTimeMs);

            return closed;
        }

        this.accumulate(this.formingCandle, price, volumeDelta);

        return null;
    }

    // Closes the forming candle if its interval boundary has already elapsed at
    // `nowMs`, independent of any tick arriving. Live drives this from a wall-clock
    // timer so a quiet symbol's bar still graduates on schedule; backtest never calls
    // it (it closes bars on kline boundaries). Same close→graduate body either way.
    closeFormingIfElapsed(nowMs: number): ICandle | null {
        if (this.formingCandle === null) {
            return null;
        }

        const currentBucketOpenTimeMs = this.bucketOpenTime(nowMs);

        if (currentBucketOpenTimeMs <= this.formingCandle.openTimeMs) {
            return null;
        }

        // Already-closed bucket (the tick path graduated it first): nothing to do.
        if (this.lastClosedBucketOpenTimeMs !== null && this.formingCandle.openTimeMs <= this.lastClosedBucketOpenTimeMs) {
            this.formingCandle = null;

            return null;
        }

        const closed = this.graduate(this.formingCandle);

        this.formingCandle = null;

        return closed;
    }

    getClosedBars(): ICandle[] {
        return this.closedBars;
    }

    getLatestClosedBar(): ICandle | null {
        if (this.closedBars.length === 0) {
            return null;
        }

        return this.closedBars[this.closedBars.length - 1];
    }

    private graduate(forming: ICandle): ICandle {
        const closed: ICandle = { ...forming, isClosed: true };

        this.closedBars.push(closed);
        this.lastClosedBucketOpenTimeMs = closed.openTimeMs;

        if (this.closedBars.length > CLOSED_BAR_WINDOW_SIZE) {
            this.closedBars.shift();
        }

        return closed;
    }

    private startCandle(price: MoneyValue, volumeDelta: MoneyValue, openTimeMs: number): ICandle {
        return {
            openTimeMs,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: volumeDelta,
            quoteVolume: price.times(volumeDelta),
            isClosed: false,
        };
    }

    private accumulate(candle: ICandle, price: MoneyValue, volumeDelta: MoneyValue): void {
        candle.high = Money.max(candle.high, price);
        candle.low = Money.min(candle.low, price);
        candle.close = price;
        candle.volume = candle.volume.plus(volumeDelta);
        candle.quoteVolume = candle.quoteVolume.plus(price.times(volumeDelta));
    }

    private bucketOpenTime(timestampMs: number): number {
        return Math.floor(timestampMs / this.intervalMs) * this.intervalMs;
    }
}

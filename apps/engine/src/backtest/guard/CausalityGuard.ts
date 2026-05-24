import { ICandle } from '../../market-data/interface';

// Thrown when a bar that is not yet closed (or that lies in the future relative to the
// decision point) leaks into a strategy evaluation. The replay invariant is: at the
// moment a signal is computed for the bar that closed at `signalBarOpenMs`, fills land
// at `signalBarOpenMs + intervalMs` (the next bar's open) — so every bar visible to the
// strategy must have an open-time strictly less than that next-bar open. Any violation
// is look-ahead bias and corrupts the replay.
export class CausalityViolationException extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CausalityViolationException';
    }
}

// Validates that every candle in `window` has openTimeMs strictly less than
// `signalBarOpenMs + intervalMs` (the next-bar boundary). `signalBarOpenMs` is the
// bar that just closed (the last bar in window) and fills happen at next-bar open.
// Throws CausalityViolationException on the first violating bar.
export function assertNoLookAhead(window: readonly ICandle[], signalBarOpenMs: number, intervalMs: number): void {
    const nextBarOpenMs = signalBarOpenMs + intervalMs;

    for (let index = 0; index < window.length; index += 1) {
        const bar = window[index];

        if (bar.openTimeMs >= nextBarOpenMs) {
            throw new CausalityViolationException(
                `Look-ahead violation at index ${index}: bar.openTimeMs=${bar.openTimeMs} >= nextBarOpenMs=${nextBarOpenMs} ` +
                    `(signalBarOpenMs=${signalBarOpenMs}, intervalMs=${intervalMs})`,
            );
        }
    }
}

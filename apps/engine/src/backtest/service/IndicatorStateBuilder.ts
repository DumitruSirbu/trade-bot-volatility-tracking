import { Injectable } from '@nestjs/common';

import { Money } from '../../common/utils/money';
import { ATR_PERIOD, CLOSED_BAR_WINDOW_SIZE } from '../../market-data/const';
import { computeIndicatorSnapshot } from '../../market-data/indicator/computeIndicatorSnapshot';
import { ICandle, IIndicatorSnapshot } from '../../market-data/interface';

// Number of milliseconds in a UTC day. Used to derive the day boundary for sessionBars
// from the latest bar's openTimeMs. UTC is the project-wide trading session anchor.
const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

// Placeholder for the event-anchored VWAP in backtest W1. The live recompute path
// supplies a real anchor maintained by SymbolMarketState; the backtest will compute its
// own anchor in a later wave (M7) where the anchor-comparison feature is exercised.
// Until then the snapshot carries a zero anchor — the trigger uses the rolling 20-bar
// anchor (ACTIVE_VWAP_ANCHOR_TYPE), so the placeholder doesn't affect decision logic.
const EVENT_ANCHORED_VWAP_PLACEHOLDER = new Money(0);

// Maintains a per-symbol sliding window of CLOSED 5-minute bars (up to
// CLOSED_BAR_WINDOW_SIZE) and computes IIndicatorSnapshot for the replay evaluator.
// The builder itself is stateless — the caller owns the bar buffer and passes it in.
// This avoids shared mutable state across concurrent replay runs.
@Injectable()
export class IndicatorStateBuilder {
    // Truncates a slice of warm-up candles down to the bounded window. Callers usually
    // load `CLOSED_BAR_WINDOW_SIZE` bars preceding the replay window's first tradable
    // bar; this method drops any excess so the initial state matches live exactly.
    buildInitialWindow(candles: ICandle[]): ICandle[] {
        if (candles.length <= CLOSED_BAR_WINDOW_SIZE) {
            return [...candles];
        }

        return candles.slice(candles.length - CLOSED_BAR_WINDOW_SIZE);
    }

    // Returns a NEW window with `bar` appended; shifts off the oldest if length would
    // exceed CLOSED_BAR_WINDOW_SIZE. The input is not mutated — replay runs share no
    // buffer state.
    appendBar(window: ICandle[], bar: ICandle): ICandle[] {
        const next = [...window, bar];

        if (next.length <= CLOSED_BAR_WINDOW_SIZE) {
            return next;
        }

        return next.slice(next.length - CLOSED_BAR_WINDOW_SIZE);
    }

    // Computes the indicator snapshot from the current window. Returns null until the
    // window has at least ATR_PERIOD bars (the longest single-period lookback that
    // produces a meaningful value); below that the snapshot would be undefined and the
    // strategy must skip the bar. `sessionBars` are the subset of `window` whose
    // openTimeMs falls within the same UTC day as the latest bar — matching how
    // SymbolMarketState resets `sessionBars` at UTC day boundaries (ADR §4).
    computeSnapshot(symbol: string, window: ICandle[]): IIndicatorSnapshot | null {
        if (window.length < ATR_PERIOD) {
            return null;
        }

        const latest = window[window.length - 1];
        const dayStartMs = Math.floor(latest.openTimeMs / MS_PER_UTC_DAY) * MS_PER_UTC_DAY;
        const sessionBars = window.filter((bar) => bar.openTimeMs >= dayStartMs);

        return computeIndicatorSnapshot({
            symbol,
            closedBars: window,
            sessionBars,
            eventAnchoredVwap: EVENT_ANCHORED_VWAP_PLACEHOLDER,
        });
    }
}

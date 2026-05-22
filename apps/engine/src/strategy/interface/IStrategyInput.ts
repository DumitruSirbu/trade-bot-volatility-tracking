import { IMarketSnapshot, IStrategyParams, IVolatilityDetectedEvent } from '@bot/shared';

import { IOpenPositionState } from './IOpenPositionState';

// The single grouped argument to IStrategy.evaluate (ADR 0003 §1). All fields are
// readonly: a strategy reads them and mutates nothing. Inputs come entirely from
// closed-bar data (no look-ahead). nowMs is the deterministic clock derived from the bar
// close, never the wall clock — this is what makes backtests reproduce live behaviour.
export interface IStrategyInput {
    readonly event: IVolatilityDetectedEvent; // enriched closed-bar payload (flow_type already classified)
    readonly snapshot: IMarketSnapshot; // the exact JSONB that will be persisted (string-money form)
    readonly openPosition: IOpenPositionState | null; // the symbol's current open position, or null
    readonly params: IStrategyParams; // typed, validated params for the active version
    readonly nowMs: number; // = event.entryCandleOpenTime + CANDLE_INTERVAL_MS (bar-close-derived)
}

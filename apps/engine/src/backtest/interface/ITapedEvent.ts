import { FlowTypeEnum, IVolatilityDetectedEvent, RegimeLabelEnum } from '@bot/shared';

// One entry on the recorded event tape (ADR 0017 §2.2). The tape is produced by
// `BacktestRunnerService.recordEventTape` in pass 1: it walks the same candle / indicator
// pipeline a normal `run` walks, but instead of dispatching each fired trigger to a
// strategy, it appends a stable `ITapedEvent` to an in-memory array.
//
// `eventId` is the M3 stable trigger id (`${symbol}:${barOpenTimeMs}`); pass 2 keys per-
// version outcomes by it so the comparison is by-event, not by-timestamp-paired-trade.
//
// `marketSnapshot` holds the full `IVolatilityDetectedEvent` payload as-detected. Pass 2
// feeds this snapshot back into `replayTape` so every candidate strategy evaluates the
// SAME event under the SAME market path (ADR 0017 §2.2 #3) — different versions may route
// it differently (open/skip/missed) but the upstream detection is version-agnostic.
//
// `regime` and `flowType` are stamped at trigger time and are convenience denormalizations
// of fields already present on `marketSnapshot` (regime = event.regimeLabel; flowType is
// derived by `classifyFlowType` against the active params). They live at the top level so
// the W5 regime-breakdown aggregator (ADR 0017 §2.4) and W5 flow filters can group without
// re-classifying.
export interface ITapedEvent {
    readonly eventId: string;
    readonly symbol: string;
    readonly triggerTs: number;
    readonly regime: RegimeLabelEnum;
    readonly flowType: FlowTypeEnum;
    readonly marketSnapshot: IVolatilityDetectedEvent;
}

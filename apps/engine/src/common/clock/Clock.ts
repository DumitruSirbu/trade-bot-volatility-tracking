// M9 R1 #5 — shared boundary clock. Previously colocated with `HaltController`
// (control module) but consumed cross-module by `DailyPnlSummaryScheduler` and
// `RiskListeners` (alert module). Moved to `common/` so cross-module consumers
// no longer import from a controller file (conventions §Folder layout).
//
// The `CLOCK` symbol + `IClock` port let adversarial tests pin time without
// monkey-patching the global `Date`; production wires `SystemClock` once via
// `ControlModule`.

export const CLOCK = Symbol('CLOCK');

export interface IClock {
    now(): Date;
}

export class SystemClock implements IClock {
    now(): Date {
        return new Date();
    }
}

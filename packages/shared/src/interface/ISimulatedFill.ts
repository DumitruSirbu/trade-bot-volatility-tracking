// M11a W0.5: Shadow fill simulator output contract.
// Pinned inline in M11a §W0.5 and ADR 0029 §2.3.2 for queryability from the read API.
// Produced by the M7 BacktestRunnerService fill simulator and stored in shadow_decisions.simulated_fill (jsonb).
// Money fields are strings (decimal-as-string) to prevent float corruption across the wire.
export interface ISimulatedFill {
    readonly entryPrice: string; // decimal
    readonly exitPrice: string | null; // null until close
    readonly slippageEntryPct: string; // decimal, signed
    readonly slippageExitPct: string | null;
    readonly slippageComponents: {
        readonly tierBase: string;
        readonly latency: string;
        readonly crossingSpread: string;
    };
    readonly missed: boolean; // true if simulator skipped the fill
    readonly forceClose: boolean; // true if closed by end-of-window rule
    readonly lowFidelity: boolean; // mirrors M7 IBacktestReport
    readonly closedAt: string | null; // ISO timestamp of simulated close
    readonly closeReason: 'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | null;
}

import { MoneyValue } from '../../common/utils/money';

// A per-UTC-day risk-state row, normalised for the gate (ADR 0004 §5/§7). Money fields are
// MoneyValue inside the engine. Live impl reads RiskStateRepository; backtest seeds an
// in-memory map from the replay.
export interface IRiskStateDay {
    readonly date: string; // UTC date key YYYY-MM-DD
    readonly realizedPnlDay: MoneyValue;
    readonly openExposure: MoneyValue;
    readonly tradesCount: number;
    readonly isHalted: boolean;
    readonly haltReason: string | null;
}

// State port for daily/weekly windows + global-halt flag (ADR 0004 §5/§7). The orchestrator
// resolves the concrete reads at the boundary and hands the gate the loaded values; the
// pure decision core never reaches into TypeORM.
export interface IRiskStatePort {
    getDay(dateString: string): Promise<IRiskStateDay | null>;
    // Rolling weekly window (ADR 0004 §5): inclusive [fromDate, toDate] by UTC date. The
    // upper bound prevents a future-dated replay/seed row from leaking into the sum.
    sumRealizedPnlBetween(fromDate: string, toDate: string): Promise<MoneyValue>;
    upsertDay(day: IRiskStateDay): Promise<void>;
    // M23 (ADR 0004 §6d). Inverse of a halt write for breadth auto-resume: set is_halted=false,
    // halt_reason=null for the UTC day, PRESERVING the PnL/exposure/trade counters so the
    // daily/weekly loss windows still bind after resume. Idempotent on the UTC-day key.
    clearHaltForDate(date: string): Promise<void>;
}

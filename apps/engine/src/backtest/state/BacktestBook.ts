import { IBacktestPosition, IBacktestTradeResult } from '@bot/shared';

import { IInstrumentConstraints } from '../../risk/interface';
import { IRiskStateDay } from '../../risk/interface/IRiskStatePort';

// Per-run in-memory state shared by all backtest port adapters (ADR 0015 §2.4). Constructed
// fresh by BacktestRunnerService.run(config) so nothing leaks into the live DI graph and so
// no replay can ever touch the real `positions` / `risk_state` tables.
export class BacktestBook {
    // Open positions keyed by synthetic positionId (UUID minted at open).
    readonly openPositions: Map<string, IBacktestPosition> = new Map();

    // Completed round-trips. Populated at position close.
    readonly completedTrades: IBacktestTradeResult[] = [];

    // Daily PnL/exposure state. Upserted by BacktestRiskStateAdapter.upsertDay.
    readonly riskStateByDay: Map<string, IRiskStateDay> = new Map();

    // Instrument constraints pre-seeded by BacktestRunnerService before replay starts.
    // Key = symbol, value = IInstrumentConstraints.
    readonly instruments: Map<string, IInstrumentConstraints> = new Map();

    // Per-day, per-symbol entry count for the overtrading gate. Key format
    // `${dateString}:${symbol}` — combining both into one map keeps lookups O(1) and
    // matches the per-symbol-per-day shape the gate needs.
    private readonly openedOnDaySymbol: Map<string, number> = new Map();

    incrementOpenedOnDay(symbol: string, dateString: string): void {
        const key = this.openedOnDayKey(symbol, dateString);
        const current = this.openedOnDaySymbol.get(key) ?? 0;
        this.openedOnDaySymbol.set(key, current + 1);
    }

    countOpenedOnDay(symbol: string, dateString: string): number {
        return this.openedOnDaySymbol.get(this.openedOnDayKey(symbol, dateString)) ?? 0;
    }

    openPositionCount(): number {
        return this.openPositions.size;
    }

    openPositionList(): IBacktestPosition[] {
        return Array.from(this.openPositions.values());
    }

    private openedOnDayKey(symbol: string, dateString: string): string {
        return `${dateString}:${symbol}`;
    }
}

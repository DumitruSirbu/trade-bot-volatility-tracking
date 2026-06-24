import { Money, MoneyValue } from '../../common/utils/money';
import { IRiskStateDay, IRiskStatePort } from '../../risk/interface/IRiskStatePort';
import { BacktestBook } from '../state/BacktestBook';

// In-memory IRiskStatePort backed by BacktestBook (ADR 0015 §2.4). Daily rows are seeded
// and mutated by the runner as the replay progresses; the gate reads them through this
// adapter exactly as it would the live RiskStateRepository.
export class BacktestRiskStateAdapter implements IRiskStatePort {
    constructor(private readonly book: BacktestBook) {}

    async getDay(dateString: string): Promise<IRiskStateDay | null> {
        return this.book.riskStateByDay.get(dateString) ?? null;
    }

    async sumRealizedPnlBetween(fromDate: string, toDate: string): Promise<MoneyValue> {
        let total: MoneyValue = new Money(0);

        for (const day of this.book.riskStateByDay.values()) {
            if (day.date >= fromDate && day.date <= toDate) {
                total = total.plus(day.realizedPnlDay);
            }
        }

        return total;
    }

    async upsertDay(day: IRiskStateDay): Promise<void> {
        this.book.riskStateByDay.set(day.date, day);
    }

    // M45 D3a. Column-scoped halt write mirroring the live newer-wins upsert: persist only the
    // halt columns, PRESERVING the day's PnL/exposure/trade counters. Seeds empty accounting for
    // a brand-new UTC day (matching the live INSERT defaults) so the backtest replays identically.
    async upsertHaltForDay(date: string, isHalted: boolean, haltReason: string | null): Promise<void> {
        const existing = this.book.riskStateByDay.get(date);

        if (existing === undefined) {
            this.book.riskStateByDay.set(date, {
                date,
                realizedPnlDay: new Money(0),
                openExposure: new Money(0),
                tradesCount: 0,
                isHalted,
                haltReason,
            });

            return;
        }

        this.book.riskStateByDay.set(date, { ...existing, isHalted, haltReason });
    }

    // M23 (ADR 0004 §6d). Breadth auto-resume clears the day-halt in place, preserving the
    // PnL/exposure/trade counters so the backtest replays the live resume path identically.
    async clearHaltForDate(date: string): Promise<void> {
        const existing = this.book.riskStateByDay.get(date);

        if (existing === undefined) {
            return;
        }

        this.book.riskStateByDay.set(date, { ...existing, isHalted: false, haltReason: null });
    }
}

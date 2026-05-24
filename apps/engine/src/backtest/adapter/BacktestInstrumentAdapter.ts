import { IInstrumentConstraints, IInstrumentPort } from '../../risk/interface';
import { BacktestBook } from '../state/BacktestBook';

// In-memory IInstrumentPort backed by BacktestBook (ADR 0015 §2.4). The runner pre-seeds
// book.instruments from the persisted instruments snapshot before replay starts; this
// adapter is a pure lookup with no fallback so a missing seed surfaces as a null at the
// gate boundary instead of being silently fabricated.
export class BacktestInstrumentAdapter implements IInstrumentPort {
    constructor(private readonly book: BacktestBook) {}

    async findConstraints(symbol: string): Promise<IInstrumentConstraints | null> {
        return this.book.instruments.get(symbol) ?? null;
    }
}

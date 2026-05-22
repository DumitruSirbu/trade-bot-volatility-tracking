import { Injectable } from '@nestjs/common';
import { CoinTierEnum } from '@bot/shared';

import { SymbolMarketState } from '../state';

// Owns the per-symbol SymbolMarketState map. Lazily creates state on first sight
// of a universe symbol; provides read access to the other market-data services.
@Injectable()
export class SymbolStateRegistry {
    private readonly states = new Map<string, SymbolMarketState>();

    getOrCreate(symbol: string, tier: CoinTierEnum): SymbolMarketState {
        const existing = this.states.get(symbol);

        if (existing !== undefined) {
            existing.setTier(tier);

            return existing;
        }

        const created = new SymbolMarketState(symbol, tier);

        this.states.set(symbol, created);

        return created;
    }

    get(symbol: string): SymbolMarketState | null {
        return this.states.get(symbol) ?? null;
    }

    all(): SymbolMarketState[] {
        return [...this.states.values()];
    }

    remove(symbol: string): void {
        this.states.delete(symbol);
    }
}

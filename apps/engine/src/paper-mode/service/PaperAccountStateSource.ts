import { IAccountStateSource, IBalance, IFunding, IOrder, IPosition } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { PaperAccountStateService } from './PaperAccountStateService';

// PAPER adapter for the shared `IAccountStateSource` port (ADR 0032 §3 D14).
//
// R2b wave-B real implementation backed by `PaperAccountStateService` — the
// in-memory + persisted-projection simulator state owner. Returns the
// simulator's view of the world; callers rebound to this port under PAPER
// see no exchange-side positions, balances, orders, or funding events
// (D14 — engine-local property).
//
// Compile-time invariant (ADR 0032 §2 + §3 D14): this file MUST NOT import
// any ccxt module. The R2a.5 module-graph sentinel test asserts the
// `paper-mode/` module's transitive closure has zero ccxt edges.

@Injectable()
export class PaperAccountStateSource implements IAccountStateSource {
    constructor(private readonly state: PaperAccountStateService) {}

    async fetchBalance(): Promise<IBalance[]> {
        // PAPER tracks a single USDT wallet. The free-vs-used distinction is
        // not meaningful without margin tracking (M11a restricted profile is
        // isolated-margin, single position) — both fields carry the same
        // value. R2c may refine if margin reservation lands.
        const view = this.state.getBalance();
        const total = view.balanceUsdt.toFixed();

        return [
            {
                asset: 'USDT',
                free: total,
                used: '0',
                total,
            },
        ];
    }

    async fetchPositions(symbol?: string): Promise<IPosition[]> {
        const positions = this.state.getOpenPositions(symbol);

        return positions.map((p) => {
            // markPrice is stale-but-non-null in R2b — falls back to
            // entryPrice. R2c lands a per-symbol last-tick cache so the
            // returned mark reflects the latest WS observation. Documented
            // as a known limitation in the addendum's R2c follow-ups.
            const fallbackMark = p.entryPrice.toFixed();

            return {
                symbol: p.symbol,
                side: p.side,
                qty: p.size.toFixed(),
                entryPrice: p.entryPrice.toFixed(),
                markPrice: fallbackMark,
                liquidationPrice: null,
                marginType: 'isolated',
                leverage: String(p.leverage),
                timestampMs: p.openedAt.getTime(),
            };
        });
    }

    async fetchOpenOrders(_symbol?: string): Promise<IOrder[]> {
        // PAPER's fill policies (marketable-limit-IOC, post-only-maker close-
        // immediately-or-cancel, reduce-market) do not leave resting orders.
        // SL/TP are evaluated intra-bar by the streaming fill adapter (D15)
        // rather than placed as resting protective orders. Always empty.
        return [];
    }

    async fetchFundingHistory(_symbol: string, _since: number): Promise<IFunding[]> {
        // Funding history surface lives on PaperFundingAccrualService (R2c).
        // The port returns empty until that wave wires the historical
        // projection from `paper_state_audit` rows with mutation_kind=
        // 'APPLY_FUNDING'.
        return [];
    }
}

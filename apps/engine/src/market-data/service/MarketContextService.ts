import { Injectable } from '@nestjs/common';

import {
    BREADTH_WINDOW_15M_MS,
    BREADTH_WINDOW_1M_MS,
    BREADTH_WINDOW_5M_MS,
    BTC_1M_SHOCK_PCT,
    BTC_5M_SHOCK_PCT,
    BTC_REFERENCE_SYMBOL,
    ETH_5M_SHOCK_PCT,
    ETH_REFERENCE_SYMBOL,
    FUNDING_EXTREME_ANNUALIZED_PCT,
    OI_CHANGE_5M_MS,
    OI_SHOCK_5M_PCT,
    SPREAD_WIDENING_PCT,
} from '../const';
import { IBreadthSnapshot, IMarketStressInputs } from '../interface';
import { SymbolStateRegistry } from './SymbolStateRegistry';

// Cross-symbol context derived from already-streamed ticker data: market breadth
// (% of universe up over 1m/5m/15m), the BTC/ETH reference moves used for
// idiosyncrasy + stress, and the fast market-stress flags that feed M4's halt.
// All inputs come from the broad tape — no deep data required.
@Injectable()
export class MarketContextService {
    constructor(private readonly registry: SymbolStateRegistry) {}

    breadth(nowMs: number): IBreadthSnapshot {
        return {
            upPct1m: this.upPctOverWindow(BREADTH_WINDOW_1M_MS, nowMs),
            upPct5m: this.upPctOverWindow(BREADTH_WINDOW_5M_MS, nowMs),
            upPct15m: this.upPctOverWindow(BREADTH_WINDOW_15M_MS, nowMs),
        };
    }

    btc5mMovePct(nowMs: number): number {
        return this.referenceMove(BTC_REFERENCE_SYMBOL, BREADTH_WINDOW_5M_MS, nowMs);
    }

    // Bar-aligned BTC 5-min move (latest vs prior closed bar) — the idiosyncrasy
    // filter's denominator (coin) is bar-to-bar, so the BTC numerator must match the
    // same horizon to avoid biasing the correlation filter. Reproduces in backtest.
    btc5mBarMovePct(): number {
        const state = this.registry.get(BTC_REFERENCE_SYMBOL);

        if (state === null) {
            return 0;
        }

        return state.barToBarMovePct();
    }

    btc1mMovePct(nowMs: number): number {
        return this.referenceMove(BTC_REFERENCE_SYMBOL, BREADTH_WINDOW_1M_MS, nowMs);
    }

    eth5mMovePct(nowMs: number): number {
        return this.referenceMove(ETH_REFERENCE_SYMBOL, BREADTH_WINDOW_5M_MS, nowMs);
    }

    eth1mMovePct(nowMs: number): number {
        return this.referenceMove(ETH_REFERENCE_SYMBOL, BREADTH_WINDOW_1M_MS, nowMs);
    }

    // Fast market-stress inputs, independent of the lagging ADX (M1 task → M4 halt).
    stressInputs(nowMs: number): IMarketStressInputs {
        const btc1m = this.btc1mMovePct(nowMs);
        const btc5m = this.btc5mMovePct(nowMs);
        const eth1m = this.eth1mMovePct(nowMs);
        const eth5m = this.eth5mMovePct(nowMs);

        return {
            btc1mMovePct: btc1m,
            btc5mMovePct: btc5m,
            eth1mMovePct: eth1m,
            eth5mMovePct: eth5m,
            btc1mShock: Math.abs(btc1m) >= BTC_1M_SHOCK_PCT,
            btc5mShock: Math.abs(btc5m) >= BTC_5M_SHOCK_PCT,
            eth5mShock: Math.abs(eth5m) >= ETH_5M_SHOCK_PCT,
            oiShock: this.isOpenInterestShock(BTC_REFERENCE_SYMBOL, nowMs),
            fundingExtreme: this.isFundingExtreme(BTC_REFERENCE_SYMBOL),
            spreadWidening: this.isSpreadWidening(BTC_REFERENCE_SYMBOL),
            // Intentional placeholder: depth-collapse detection needs the tiered order
            // book and is wired in M4 (fast market-stress / halt). Hardcoded false here
            // keeps the IMarketStressInputs shape stable until then — not dead code.
            depthCollapse: false,
        };
    }

    private upPctOverWindow(windowMs: number, nowMs: number): number {
        const states = this.registry.all();
        let counted = 0;
        let up = 0;

        for (const state of states) {
            const move = state.movePctOverWindow(windowMs, nowMs);

            if (move !== null) {
                counted += 1;

                if (move > 0) {
                    up += 1;
                }
            }
        }

        if (counted === 0) {
            return 0;
        }

        return (up / counted) * 100;
    }

    private referenceMove(symbol: string, windowMs: number, nowMs: number): number {
        const state = this.registry.get(symbol);

        if (state === null) {
            return 0;
        }

        return state.movePctOverWindow(windowMs, nowMs) ?? 0;
    }

    private isOpenInterestShock(symbol: string, nowMs: number): boolean {
        const state = this.registry.get(symbol);

        if (state === null) {
            return false;
        }

        const change = state.openInterestChangePct(OI_CHANGE_5M_MS, nowMs);

        return change !== null && Math.abs(change) >= OI_SHOCK_5M_PCT;
    }

    private isFundingExtreme(symbol: string): boolean {
        const state = this.registry.get(symbol);

        if (state === null) {
            return false;
        }

        const annualized = state.getFundingRateAnnualized();

        return annualized !== null && Math.abs(annualized) >= FUNDING_EXTREME_ANNUALIZED_PCT;
    }

    private isSpreadWidening(symbol: string): boolean {
        const state = this.registry.get(symbol);

        if (state === null) {
            return false;
        }

        const spread = state.getSpreadPct();

        return spread !== null && spread >= SPREAD_WIDENING_PCT;
    }
}

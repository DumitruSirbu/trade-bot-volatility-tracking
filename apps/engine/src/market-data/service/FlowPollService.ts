import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { parseMoney } from '../../common/utils/money';
import { DEFAULT_FUNDING_INTERVAL_HOURS, FUNDING_POLL_MS, HOURS_PER_YEAR, OI_BASELINE_POLL_MS } from '../const';
import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { sanitizeExchangeError } from '../../exchange/utils';
import { SymbolMarketState } from '../state';
import { SymbolStateRegistry } from './SymbolStateRegistry';
import { UniverseService } from './UniverseService';

// Polls Open Interest and funding via REST (no all-symbol socket for either,
// ADR §2). Baseline cadence covers the whole universe; escalated symbols (near
// the trigger) are polled on the faster sub-interval. Funding is a crowding/
// trailing signal — it feeds the flow classifier and risk skips, not direction.
@Injectable()
export class FlowPollService {
    private readonly logger = new Logger(FlowPollService.name);

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly registry: SymbolStateRegistry,
        private readonly universe: UniverseService,
    ) {}

    @Interval(OI_BASELINE_POLL_MS)
    async pollOpenInterestBaseline(): Promise<void> {
        await this.pollOpenInterestFor(this.universe.getEntries().map((entry) => entry.symbol));
    }

    @Interval(FUNDING_POLL_MS)
    async pollFunding(): Promise<void> {
        await this.pollFundingFor(this.universe.getEntries().map((entry) => entry.symbol));
    }

    // Called by the escalation path for a single near-trigger symbol (faster OI).
    async pollOpenInterestForSymbol(symbol: string): Promise<void> {
        await this.pollOpenInterestFor([symbol]);
    }

    // OI fetches per symbol are independent I/O — fan out in parallel rather than
    // serializing hundreds of REST round-trips (ccxt's rate-limiter still paces them).
    private async pollOpenInterestFor(symbols: string[]): Promise<void> {
        await Promise.all(
            symbols.map((symbol) => {
                const state = this.registry.get(symbol);

                if (state === null) {
                    return Promise.resolve();
                }

                return this.fetchOpenInterestInto(symbol, state);
            }),
        );
    }

    private async fetchOpenInterestInto(symbol: string, state: SymbolMarketState): Promise<void> {
        try {
            const snapshot = await this.exchangeClient.fetchOpenInterest(symbol);
            const raw = snapshot.openInterestValue ?? snapshot.openInterestAmount;

            if (raw !== null) {
                state.recordOpenInterest(parseMoney(raw), snapshot.timestampMs);
            }
        } catch (cause) {
            this.logger.warn(`OI poll failed for ${symbol}: ${sanitizeExchangeError(cause)}`);
        }
    }

    private async pollFundingFor(symbols: string[]): Promise<void> {
        await Promise.all(
            symbols.map((symbol) => {
                const state = this.registry.get(symbol);

                if (state === null) {
                    return Promise.resolve();
                }

                return this.fetchFundingInto(symbol, state);
            }),
        );
    }

    private async fetchFundingInto(symbol: string, state: SymbolMarketState): Promise<void> {
        try {
            const snapshot = await this.exchangeClient.fetchFundingRate(symbol);

            state.setFunding(snapshot.fundingRate, this.annualize(snapshot.fundingRate, snapshot.fundingIntervalHours));
        } catch (cause) {
            this.logger.warn(`Funding poll failed for ${symbol}: ${sanitizeExchangeError(cause)}`);
        }
    }

    // Annualized % = rate × (year hours / interval hours) × 100. Funding accrues
    // per interval (8h default), so periods-per-year scales the periodic rate.
    private annualize(rate: number | null, intervalHours: number | null): number | null {
        if (rate === null) {
            return null;
        }

        const interval = intervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS;

        return rate * (HOURS_PER_YEAR / interval) * 100;
    }
}

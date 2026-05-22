import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';

import { FUNDING_RATE_OBSERVED_EVENT, MS_PER_HOUR, OPEN_INTEREST_SAMPLED_EVENT } from '../../common/const';
import { MoneyValue, parseMoney } from '../../common/utils/money';
import { DEFAULT_FUNDING_INTERVAL_HOURS, FUNDING_POLL_MS, HOURS_PER_YEAR, OI_BASELINE_POLL_MS } from '../const';
import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { sanitizeExchangeError } from '../../exchange/utils';
import { IFundingRateObservedEvent, IOpenInterestSampledEvent } from '../interface';
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
        private readonly eventEmitter: EventEmitter2,
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
                const value = parseMoney(raw);

                state.recordOpenInterest(value, snapshot.timestampMs);
                this.emitOpenInterestSampled(symbol, value, snapshot.timestampMs);
            }
        } catch (cause) {
            this.logger.warn(`OI poll failed for ${symbol}: ${sanitizeExchangeError(cause)}`);
        }
    }

    // OI sample is already computed here from the REST poll (ADR 0002 §4) → emit for the
    // passive persistence listener (open_interest, idempotent on UNIQUE(symbol, ts)).
    private emitOpenInterestSampled(symbol: string, value: MoneyValue, tsMs: number): void {
        const event: IOpenInterestSampledEvent = { symbol, tsMs, value };

        this.eventEmitter.emit(OPEN_INTEREST_SAMPLED_EVENT, event);
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

            if (snapshot.fundingRate !== null) {
                const settlementTimeMs = this.resolveSettlementTimeMs(snapshot.fundingTimestampMs, snapshot.timestampMs, snapshot.fundingIntervalHours);

                this.emitFundingObserved(symbol, snapshot.fundingRate, settlementTimeMs);
            }
        } catch (cause) {
            this.logger.warn(`Funding poll failed for ${symbol}: ${sanitizeExchangeError(cause)}`);
        }
    }

    // Funding event is already observed here (ADR 0002 §4) → emit for the persistence
    // listener (funding_rates, idempotent on UNIQUE(symbol, funding_time)). The periodic
    // rate is a JS number from ccxt; it crosses to a MoneyValue via its decimal string so
    // precision is preserved and no float reaches the DB column. fundingTimeMs is the 8h
    // SETTLEMENT boundary (not the poll time) so the row de-dups to one per settlement.
    private emitFundingObserved(symbol: string, fundingRate: number, fundingTimeMs: number): void {
        const event: IFundingRateObservedEvent = { symbol, fundingTimeMs, rate: parseMoney(fundingRate.toString()) };

        this.eventEmitter.emit(FUNDING_RATE_OBSERVED_EVENT, event);
    }

    // Prefer the exchange-reported settlement boundary; if absent, floor the poll time to
    // the funding interval (default 8h) so repeated polls within one interval collapse to
    // a single funding_time and never produce ~96 rows/day instead of ~3 settlements.
    private resolveSettlementTimeMs(fundingTimestampMs: number | null, quoteTimeMs: number, intervalHours: number | null): number {
        if (fundingTimestampMs !== null) {
            return fundingTimestampMs;
        }

        const intervalMs = (intervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS) * MS_PER_HOUR;

        return Math.floor(quoteTimeMs / intervalMs) * intervalMs;
    }

    // Annualized % = rate × (year hours / interval hours) × 100. Funding accrues
    // per interval (8h default), so periods-per-year scales the periodic rate.
    // NOTE: the ×100 means this is stored as a PERCENT (e.g. 10.95), NOT a ratio — do not
    // confuse it with funding_rates.rate, which stores the raw per-interval RATIO.
    private annualize(rate: number | null, intervalHours: number | null): number | null {
        if (rate === null) {
            return null;
        }

        const interval = intervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS;

        return rate * (HOURS_PER_YEAR / interval) * 100;
    }
}

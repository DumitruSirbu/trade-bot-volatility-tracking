import { Inject, Injectable, Logger } from '@nestjs/common';

import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { AGGRESSOR_WINDOW_MS, DEPTH_BAND_10_BPS, DEPTH_BAND_50_BPS } from '../const';
import { EXCHANGE_CLIENT, IExchangeClient, IOrderBookSnapshot } from '../../exchange/interface';
import { sanitizeExchangeError } from '../../exchange/utils';
import { SymbolMarketState } from '../state';
import { SymbolStateRegistry } from './SymbolStateRegistry';

// Escalated, near-trigger-only subscriptions (ADR §2 tiering). Streams the order
// book (spread + 10bps/50bps notional depth) and aggressor trades (buy/sell
// imbalance) for a small set of symbols approaching the trigger. NEVER opens deep
// books for the whole universe. Each escalated symbol runs two consume loops that
// stop when the symbol is de-escalated.
@Injectable()
export class DepthAggressorService {
    private readonly logger = new Logger(DepthAggressorService.name);

    private readonly activeSymbols = new Set<string>();

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly registry: SymbolStateRegistry,
    ) {}

    isActive(symbol: string): boolean {
        return this.activeSymbols.has(symbol);
    }

    start(symbol: string): void {
        if (this.activeSymbols.has(symbol)) {
            return;
        }

        this.activeSymbols.add(symbol);
        void this.consumeOrderBook(symbol);
        void this.consumeTrades(symbol);
        this.logger.debug(`Escalated depth/aggressor capture started for ${symbol}`);
    }

    stop(symbol: string): void {
        this.activeSymbols.delete(symbol);
    }

    private async consumeOrderBook(symbol: string): Promise<void> {
        while (this.activeSymbols.has(symbol)) {
            try {
                const book = await this.exchangeClient.watchOrderBook(symbol);
                const state = this.registry.get(symbol);

                if (state !== null) {
                    this.applyOrderBook(state, book);
                }
            } catch (cause) {
                this.logger.warn(`watchOrderBook failed for ${symbol}: ${sanitizeExchangeError(cause)}`);

                return;
            }
        }
    }

    private async consumeTrades(symbol: string): Promise<void> {
        while (this.activeSymbols.has(symbol)) {
            try {
                const trades = await this.exchangeClient.watchTrades(symbol);
                const state = this.registry.get(symbol);

                if (state !== null) {
                    this.applyTrades(state, trades);
                }
            } catch (cause) {
                this.logger.warn(`watchTrades failed for ${symbol}: ${sanitizeExchangeError(cause)}`);

                return;
            }
        }
    }

    private applyOrderBook(state: SymbolMarketState, book: IOrderBookSnapshot): void {
        const bestBid = book.bids[0];
        const bestAsk = book.asks[0];

        if (bestBid === undefined || bestAsk === undefined) {
            return;
        }

        const bid = parseMoney(bestBid.price);
        const ask = parseMoney(bestAsk.price);
        const mid = bid.plus(ask).dividedBy(2);

        if (mid.isZero()) {
            return;
        }

        const spreadPct = ask.minus(bid).dividedBy(mid).times(100).toNumber();
        const depth10 = this.notionalWithinBand(book, mid, DEPTH_BAND_10_BPS);
        const depth50 = this.notionalWithinBand(book, mid, DEPTH_BAND_50_BPS);

        state.setDepth(spreadPct, depth10, depth50);
    }

    // Sum of price × size on both sides within `band` of mid, in USDT notional.
    private notionalWithinBand(book: IOrderBookSnapshot, mid: MoneyValue, band: number): MoneyValue {
        const lower = mid.times(1 - band);
        const upper = mid.times(1 + band);
        let notional = new Money(0);

        for (const level of book.bids) {
            const price = parseMoney(level.price);

            if (price.greaterThanOrEqualTo(lower)) {
                notional = notional.plus(price.times(parseMoney(level.amount)));
            }
        }

        for (const level of book.asks) {
            const price = parseMoney(level.price);

            if (price.lessThanOrEqualTo(upper)) {
                notional = notional.plus(price.times(parseMoney(level.amount)));
            }
        }

        return notional;
    }

    private applyTrades(state: SymbolMarketState, trades: { isBuyerAggressor: boolean; amount: string; timestampMs: number }[]): void {
        for (const trade of trades) {
            const amount = parseMoney(trade.amount);
            const buy = trade.isBuyerAggressor ? amount : new Money(0);
            const sell = trade.isBuyerAggressor ? new Money(0) : amount;

            state.recordAggressorTrade(buy, sell, trade.timestampMs);
        }

        const latest = trades[trades.length - 1];

        if (latest !== undefined) {
            state.pruneAggressorTrades(AGGRESSOR_WINDOW_MS, latest.timestampMs);
        }
    }
}

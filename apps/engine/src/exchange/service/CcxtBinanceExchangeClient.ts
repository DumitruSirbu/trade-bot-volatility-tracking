import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { pro as ccxtPro } from 'ccxt';
import type { Balances, FundingRate, MarketInterface, OpenInterest, OrderBook, Ticker, Trade } from 'ccxt';

import { AppConfigService } from '../../config/service';
import { ENABLE_RATE_LIMIT, ORDER_BOOK_DEPTH_LIMIT, PERPETUAL_SETTLE_CURRENCY } from '../const';
import { ExchangeCredentialsException, ExchangeRequestException } from '../exception';
import { sanitizeExchangeError } from '../utils';
import {
    IBalanceSnapshot,
    IExchangeClient,
    IFundingRateSnapshot,
    IMarketInfo,
    IOpenInterestSnapshot,
    IOrderBookLevel,
    IOrderBookSnapshot,
    ITickerSnapshot,
    ITradeSnapshot,
} from '../interface';

// The single chokepoint for all Binance USDT-M Futures I/O. Wraps ccxt.pro's
// unified methods, normalises every response into the engine's boundary types,
// and converts any ccxt failure into a typed ExchangeRequestException so ccxt
// types and errors never leak upstream (ADR §1). Holds no rolling/indicator state.
@Injectable()
export class CcxtBinanceExchangeClient implements IExchangeClient, OnModuleDestroy {
    private readonly logger = new Logger(CcxtBinanceExchangeClient.name);

    private readonly client: InstanceType<typeof ccxtPro.binanceusdm>;

    constructor(private readonly appConfig: AppConfigService) {
        this.assertCredentialsPresent();

        this.client = new ccxtPro.binanceusdm({
            apiKey: this.appConfig.exchangeApiKey,
            secret: this.appConfig.exchangeApiSecret,
            enableRateLimit: ENABLE_RATE_LIMIT,
            options: { defaultType: 'swap' },
        });

        if (this.appConfig.isExchangeTestnet) {
            this.client.setSandboxMode(true);
            this.logger.log('Binance USDT-M client initialised in TESTNET (sandbox) mode');
        } else {
            this.logger.warn('Binance USDT-M client initialised in LIVE mode');
        }
    }

    // Both testnet and live require signed credentials to fetch balances and (M5)
    // place orders. Fail fast rather than silently building a client that rejects
    // every authenticated request.
    private assertCredentialsPresent(): void {
        const hasCredentials = Boolean(this.appConfig.exchangeApiKey) && Boolean(this.appConfig.exchangeApiSecret);

        if (!hasCredentials) {
            const profile = this.appConfig.isExchangeTestnet ? 'testnet' : 'live';

            throw new ExchangeCredentialsException(profile);
        }
    }

    async loadMarkets(): Promise<IMarketInfo[]> {
        const markets = await this.callExchange('loadMarkets', () => this.client.loadMarkets());

        return Object.values(markets).map((market) => this.toMarketInfo(market as MarketInterface));
    }

    async fetchBalance(): Promise<IBalanceSnapshot[]> {
        const balances = await this.callExchange('fetchBalance', () => this.client.fetchBalance());

        return this.toBalanceSnapshots(balances);
    }

    async fetchOpenInterest(symbol: string): Promise<IOpenInterestSnapshot> {
        const openInterest = await this.callExchange(`fetchOpenInterest:${symbol}`, () => this.client.fetchOpenInterest(symbol));

        return this.toOpenInterestSnapshot(symbol, openInterest);
    }

    async fetchFundingRate(symbol: string): Promise<IFundingRateSnapshot> {
        const fundingRate = await this.callExchange(`fetchFundingRate:${symbol}`, () => this.client.fetchFundingRate(symbol));

        return this.toFundingRateSnapshot(symbol, fundingRate);
    }

    async fetchTickers(): Promise<ITickerSnapshot[]> {
        const tickers = await this.callExchange('fetchTickers', () => this.client.fetchTickers());

        return Object.values(tickers).map((ticker) => this.toTickerSnapshot(ticker));
    }

    async watchTickers(): Promise<ITickerSnapshot[]> {
        const tickers = await this.callExchange('watchTickers', () => this.client.watchTickers());

        return Object.values(tickers).map((ticker) => this.toTickerSnapshot(ticker));
    }

    async watchOrderBook(symbol: string): Promise<IOrderBookSnapshot> {
        const orderBook = await this.callExchange(`watchOrderBook:${symbol}`, () => this.client.watchOrderBook(symbol, ORDER_BOOK_DEPTH_LIMIT));

        return this.toOrderBookSnapshot(symbol, orderBook);
    }

    async watchTrades(symbol: string): Promise<ITradeSnapshot[]> {
        const trades = await this.callExchange(`watchTrades:${symbol}`, () => this.client.watchTrades(symbol));

        return trades.map((trade) => this.toTradeSnapshot(symbol, trade));
    }

    async close(): Promise<void> {
        await this.callExchange('close', () => this.client.close());
    }

    async onModuleDestroy(): Promise<void> {
        await this.close();
    }

    // Single try/catch boundary (code-conventions "Integration calls"): log with
    // context, then rethrow as a domain exception so no ccxt error escapes.
    private async callExchange<T>(operation: string, request: () => Promise<T>): Promise<T> {
        try {
            return await request();
        } catch (cause) {
            // Carry only the SANITIZED message as the exception context — never the raw
            // ccxt error — so a future AllExceptionsFilter can't serialize an
            // unredacted signature/API key out of `cause`.
            const sanitizedCause = sanitizeExchangeError(cause);

            this.logger.error(`ccxt ${operation} failed: ${sanitizedCause}`);

            throw new ExchangeRequestException(operation, sanitizedCause);
        }
    }

    private toMarketInfo(market: MarketInterface): IMarketInfo {
        const isLinearPerpetual = market.swap === true && market.linear === true && market.settle === PERPETUAL_SETTLE_CURRENCY;

        return {
            symbol: market.symbol,
            base: market.base,
            quote: market.quote,
            settle: market.settle ?? null,
            active: market.active === true,
            isLinearPerpetual,
            contractSize: this.numberToString(market.contractSize),
            pricePrecision: market.precision?.price ?? null,
            amountPrecision: market.precision?.amount ?? null,
        };
    }

    private toBalanceSnapshots(balances: Balances): IBalanceSnapshot[] {
        const snapshots: IBalanceSnapshot[] = [];

        for (const [asset, balance] of Object.entries(balances)) {
            if (asset === 'info' || asset === 'timestamp' || asset === 'datetime') {
                continue;
            }

            snapshots.push({
                asset,
                free: this.numberToString(balance.free) ?? '0',
                used: this.numberToString(balance.used) ?? '0',
                total: this.numberToString(balance.total) ?? '0',
            });
        }

        return snapshots;
    }

    private toTickerSnapshot(ticker: Ticker): ITickerSnapshot {
        return {
            symbol: ticker.symbol,
            timestampMs: ticker.timestamp ?? Date.now(),
            last: this.numberToString(ticker.last ?? ticker.close),
            bid: this.numberToString(ticker.bid),
            ask: this.numberToString(ticker.ask),
            quoteVolume: this.numberToString(ticker.quoteVolume),
        };
    }

    private toOpenInterestSnapshot(symbol: string, openInterest: OpenInterest): IOpenInterestSnapshot {
        return {
            symbol,
            timestampMs: openInterest.timestamp ?? Date.now(),
            openInterestAmount: this.numberToString(openInterest.openInterestAmount),
            openInterestValue: this.numberToString(openInterest.openInterestValue),
        };
    }

    private toFundingRateSnapshot(symbol: string, fundingRate: FundingRate): IFundingRateSnapshot {
        return {
            symbol,
            timestampMs: fundingRate.timestamp ?? Date.now(),
            fundingRate: fundingRate.fundingRate ?? null,
            markPrice: this.numberToString(fundingRate.markPrice),
            fundingIntervalHours: this.parseFundingIntervalHours(fundingRate.interval),
        };
    }

    private toOrderBookSnapshot(symbol: string, orderBook: OrderBook): IOrderBookSnapshot {
        return {
            symbol,
            timestampMs: orderBook.timestamp ?? Date.now(),
            bids: this.toOrderBookLevels(orderBook.bids),
            asks: this.toOrderBookLevels(orderBook.asks),
        };
    }

    private toOrderBookLevels(levels: [number | undefined, number | undefined][]): IOrderBookLevel[] {
        const result: IOrderBookLevel[] = [];

        for (const [price, amount] of levels) {
            const priceString = this.numberToString(price);
            const amountString = this.numberToString(amount);

            if (priceString !== null && amountString !== null) {
                result.push({ price: priceString, amount: amountString });
            }
        }

        return result;
    }

    private toTradeSnapshot(symbol: string, trade: Trade): ITradeSnapshot {
        return {
            symbol,
            timestampMs: trade.timestamp ?? Date.now(),
            price: this.numberToString(trade.price) ?? '0',
            amount: this.numberToString(trade.amount) ?? '0',
            isBuyerAggressor: trade.side === 'buy',
        };
    }

    // ccxt parses exchange JSON into JS numbers; stringify here so all downstream
    // money math starts from a string and never touches a float (code-conventions).
    private numberToString(value: number | undefined | null): string | null {
        if (value === undefined || value === null || Number.isNaN(value)) {
            return null;
        }

        return String(value);
    }

    private parseFundingIntervalHours(interval: string | undefined): number | null {
        if (interval === undefined) {
            return null;
        }

        const match = interval.match(/^(\d+)h$/);

        if (match === null) {
            return null;
        }

        return Number.parseInt(match[1], 10);
    }
}

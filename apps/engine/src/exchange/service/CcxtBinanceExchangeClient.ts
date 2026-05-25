import { ExchangeEnvironmentEnum, IKeyPermissionSnapshot } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { pro as ccxtPro } from 'ccxt';
import type {
    Balances,
    FundingHistory,
    FundingRate,
    MarketInterface,
    OpenInterest,
    Order,
    OrderBook,
    OrderSide,
    OrderType,
    Position,
    Ticker,
    Trade,
} from 'ccxt';

import { AppConfigService } from '../../config/service';
import {
    ENABLE_RATE_LIMIT,
    KEY_PERMISSION_SOURCE_ENDPOINTS,
    ORDER_BOOK_DEPTH_LIMIT,
    PERPETUAL_SETTLE_CURRENCY,
    TRADING_AUTHORITY_NEVER_EXPIRES_SENTINEL,
} from '../const';
import { ExchangeCredentialsException, ExchangeRequestException } from '../exception';
import { parseRateLimitHeaders, sanitizeExchangeError } from '../utils';
import {
    IBalanceSnapshot,
    ICreateOrderRequest,
    IExchangeClient,
    IExchangeOrderSnapshot,
    IFundingPaymentSnapshot,
    IFundingRateSnapshot,
    IMarketInfo,
    IOpenInterestSnapshot,
    IOpenOrderSnapshot,
    IOrderBookLevel,
    IOrderBookSnapshot,
    IPositionSnapshot,
    ITickerSnapshot,
    ITradeSnapshot,
} from '../interface';
import { IRateLimitPolicy, RATE_LIMIT_POLICY, IRateLimitedCall } from '../interface/IRateLimitPolicy';
import { buildRateLimitedCall } from './RateLimitPolicyService';

// The single chokepoint for all Binance USDT-M Futures I/O. Wraps ccxt.pro's
// unified methods, normalises every response into the engine's boundary types,
// and converts any ccxt failure into a typed ExchangeRequestException so ccxt
// types and errors never leak upstream (ADR §1). Holds no rolling/indicator state.
@Injectable()
export class CcxtBinanceExchangeClient implements IExchangeClient, OnModuleDestroy {
    private readonly logger = new Logger(CcxtBinanceExchangeClient.name);

    private readonly client: InstanceType<typeof ccxtPro.binanceusdm>;

    constructor(
        private readonly appConfig: AppConfigService,
        @Inject(RATE_LIMIT_POLICY) private readonly rateLimit: IRateLimitPolicy,
    ) {
        this.assertCredentialsPresent();

        this.client = new ccxtPro.binanceusdm({
            apiKey: this.appConfig.exchangeApiKey,
            secret: this.appConfig.exchangeApiSecret,
            enableRateLimit: ENABLE_RATE_LIMIT,
            options: {
                defaultType: 'swap',
                disableFuturesSandboxWarning: true,
                warnOnFetchOpenOrdersWithoutSymbol: false,
                // CCXT's binanceusdm WS orderbook emits transient checksum-mismatch errors
                // on sequence gaps; the stream auto-recovers but each gap surfaces as an
                // ERROR-level throw. Mute per the CCXT-recommended option — reconciliation
                // already polls REST as the authoritative source for orderbook depth used
                // by the gate, so muting the WS-level checksum diagnostic does not relax
                // any safety invariant.
                watchOrderBook: { checksum: false },
            },
        });

        this.selectEnvironmentUrls(this.appConfig.exchangeEnv);
    }

    // M11a W1.1. Selects ccxt's URL set per `ExchangeEnvironmentEnum`:
    //   TESTNET -> setSandboxMode(true)            (testnet.binancefuture.com)
    //   DEMO    -> enableDemoTrading(true)         (demo-fapi.binance.com)
    //   LIVE    -> default URLs                    (fapi.binance.com)
    // Single switch keeps the URL surface and the env decision in one place;
    // any future env is fail-loud because of the exhaustive default.
    private selectEnvironmentUrls(env: ExchangeEnvironmentEnum): void {
        if (env === ExchangeEnvironmentEnum.TESTNET) {
            this.client.setSandboxMode(true);
            this.logger.log('Binance USDT-M client initialised in TESTNET (sandbox) mode');

            return;
        }

        if (env === ExchangeEnvironmentEnum.DEMO) {
            // ccxt 4.5.x ships an `enableDemoTrading(true)` helper that swaps
            // `urls.api` to the demo-fapi.binance.com / demo-api.binance.com
            // host set (binance.js §enableDemoTrading). Paper fills against
            // live order-book depth — the M11a soak target.
            this.client.enableDemoTrading(true);
            this.logger.warn('Binance USDT-M client initialised in DEMO mode (demo-fapi.binance.com)');

            return;
        }

        if (env === ExchangeEnvironmentEnum.LIVE) {
            this.logger.warn('Binance USDT-M client initialised in LIVE mode (fapi.binance.com)');

            return;
        }

        // Defence-in-depth: an unknown enum value here means env validation
        // upstream is broken. Throw rather than silently default — the bot
        // refuses to be a long-running process under a misconfigured URL set.
        throw new ExchangeCredentialsException(`unknown ExchangeEnvironmentEnum value: ${String(env)}`);
    }

    // Both testnet and live require signed credentials to fetch balances and (M5)
    // place orders. Fail fast rather than silently building a client that rejects
    // every authenticated request.
    private assertCredentialsPresent(): void {
        const hasCredentials = Boolean(this.appConfig.exchangeApiKey) && Boolean(this.appConfig.exchangeApiSecret);

        if (!hasCredentials) {
            // M11a W1.1 — profile string carries the resolved enum value so the
            // exception body is unambiguous (testnet | demo | live).
            throw new ExchangeCredentialsException(this.appConfig.exchangeEnv);
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

    async createOrder(request: ICreateOrderRequest): Promise<IExchangeOrderSnapshot> {
        const params: Record<string, unknown> = { ...(request.params ?? {}), clientOrderId: request.clientOrderId };

        // Decimal → float conversion at the ccxt boundary. ccxt's createOrder signature
        // accepts `number` and there is no decimal overload; this is the ONLY place in the
        // engine where float touches money/qty (per docs/best-practices/code-conventions.md
        // "Money is decimal" — `Number(decimalString)` is permissible AT the boundary, never
        // upstream). Both amount and price strings come from ExecutionService already
        // quantized against tickSize/stepSize at the upstream layer; the `Number()` cast is
        // therefore lossless for the precisions Binance USDT-M Futures actually accepts
        // (≤ 12 significant digits across tier-1/2/3 symbols). Anything more precise would
        // be rejected by Binance's PRICE_FILTER / LOT_SIZE filters before lossy float
        // arithmetic could matter — fail fast at the venue rather than silently round.
        const price = request.price === null || request.price === undefined ? undefined : Number(request.price);
        const amount = Number(request.amount);

        const order = await this.callExchange(`createOrder:${request.symbol}:${request.clientOrderId}`, () =>
            this.client.createOrder(request.symbol, request.type as OrderType, request.side as OrderSide, amount, price, params),
        );

        return this.toOrderSnapshot(order);
    }

    async fetchOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        try {
            // Binance USDT-M Futures looks up by origClientOrderId; ccxt unifies both naming
            // variants via `clientOrderId` in params. Id positional arg is required by ccxt's
            // signature but ignored when origClientOrderId is supplied.
            const order = await this.client.fetchOrder('', symbol, { clientOrderId, origClientOrderId: clientOrderId });

            return this.toOrderSnapshot(order);
        } catch (cause) {
            if (this.isOrderNotFound(cause)) {
                return null;
            }

            const sanitizedCause = sanitizeExchangeError(cause);
            this.logger.error(`ccxt fetchOrderByClientId:${symbol}:${clientOrderId} failed: ${sanitizedCause}`);

            throw new ExchangeRequestException(`fetchOrderByClientId:${symbol}:${clientOrderId}`, sanitizedCause);
        }
    }

    async cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot> {
        const order = await this.callExchange(`cancelOrderByClientId:${symbol}:${clientOrderId}`, () =>
            this.client.cancelOrder('', symbol, { clientOrderId, origClientOrderId: clientOrderId }),
        );

        return this.toOrderSnapshot(order);
    }

    private isOrderNotFound(cause: unknown): boolean {
        // ccxt translates Binance -2013 "Order does not exist" into OrderNotFound (subclass
        // of ExchangeError). The class name check is safer than message matching because the
        // localized message string can change between ccxt releases.
        const name = cause instanceof Error ? cause.constructor.name : '';

        return name === 'OrderNotFound';
    }

    // M6 W4a (ADR 0010 §2 step 1, §7): exchange-side truth read by ReconciliationService.
    // ccxt's `fetchPositions` returns one entry per `(symbol, positionSide)` with `contracts`
    // possibly zero (some venues report all hedged-mode slots even when flat). We filter
    // zero-qty entries at the boundary so the reconciliation tick never has to.
    async fetchPositions(): Promise<readonly IPositionSnapshot[]> {
        const positions = await this.callExchange('fetchPositions', () => this.client.fetchPositions());

        return positions.map((position) => this.toPositionSnapshot(position)).filter((snapshot) => this.isNonZeroPositionQty(snapshot));
    }

    // M6 W4a (ADR 0010 §2 step 2, §7): all resting orders across symbols. Used by case (e)
    // PROTECTIVE_ORDER_DRIFT to verify the protective `-sl` / `-tp` orders are still present
    // for every `protective_order_type=exchange_side` row.
    // M6 W5 (ADR 0012 §2). Wraps ccxt's `fetchFundingHistory` which over Binance USDT-M
    // hits `GET /fapi/v1/income?incomeType=FUNDING_FEE`. `sinceMs` is the inclusive
    // lower bound (the venue may return rows >= sinceMs; the caller dedupes by tranId
    // upstream). Limit is left to ccxt's default — Binance returns up to 1000 rows per
    // call, easily covering the 30s reconciliation cadence (1 funding event per 8h
    // per symbol).
    async fetchFundingHistory(symbol: string, sinceMs: number): Promise<readonly IFundingPaymentSnapshot[]> {
        const rows = await this.callExchange(`fetchFundingHistory:${symbol}`, () => this.client.fetchFundingHistory(symbol, sinceMs));

        return rows.map((row) => this.toFundingPaymentSnapshot(row));
    }

    async fetchOpenOrders(): Promise<readonly IOpenOrderSnapshot[]> {
        const orders = await this.callExchange('fetchOpenOrders', () => this.client.fetchOpenOrders());

        return orders.map((order) => this.toOpenOrderSnapshot(order));
    }

    // M11a W1.2 (ADR 0028 §2.2). Two ccxt calls merged into one boundary type
    // so the boot caller reads a single snapshot. Failures propagate as
    // ExchangeRequestException; the caller maps that into assertion-failure
    // (ADR §2.5).
    async fetchKeyPermissions(): Promise<IKeyPermissionSnapshot> {
        const [restrictions, ipRestriction] = await Promise.all([
            this.callExchange('sapiGetAccountApiRestrictions', () => this.callSapiGetAccountApiRestrictions()),
            this.callExchange('sapiGetAccountApiRestrictionsIpRestriction', () => this.callSapiGetAccountApiRestrictionsIpRestriction()),
        ]);

        return this.toKeyPermissionSnapshot(restrictions, ipRestriction);
    }

    private async callSapiGetAccountApiRestrictions(): Promise<Record<string, unknown>> {
        return this.callSapiMethod<Record<string, unknown>>('sapiGetAccountApiRestrictions');
    }

    private async callSapiGetAccountApiRestrictionsIpRestriction(): Promise<Record<string, unknown>> {
        return this.callSapiMethod<Record<string, unknown>>('sapiGetAccountApiRestrictionsIpRestriction');
    }

    // ccxt's binanceusdm exposes spot-side restriction endpoints via implicit
    // `sapi*` methods on the parent binance class. The narrow cast in one
    // place lets us call those endpoints through the ccxt-pro surface without
    // declaring every implicit endpoint signature at each call site.
    private async callSapiMethod<T>(methodName: string): Promise<T> {
        const sapiClient = this.client as unknown as Record<string, () => Promise<T>>;
        const method = sapiClient[methodName];

        if (typeof method !== 'function') {
            throw new Error(`ccxt client does not expose sapi method '${methodName}'`);
        }

        return method.call(sapiClient);
    }

    async close(): Promise<void> {
        await this.callExchange('close', () => this.client.close());
    }

    async onModuleDestroy(): Promise<void> {
        await this.close();
    }

    // Single try/catch boundary (code-conventions "Integration calls"): log with
    // context, then rethrow as a domain exception so no ccxt error escapes.
    //
    // M11a W1.4 (ADR 0030). The boundary now also enforces the rate-limit policy
    // around every ccxt call: `acquire()` before the call, and
    // `reconcileFromHeaders()` after every response (success AND failure — Binance
    // returns rate-limit headers on 4xx too). The descriptor maps the legacy
    // `operation:symbol` tag string into a typed IRateLimitedCall via
    // `buildRateLimitedCall`; an unknown operation throws at acquisition time
    // so no new call site can drift past the limiter.
    private async callExchange<T>(operation: string, request: () => Promise<T>): Promise<T> {
        const call = this.descriptorFromTag(operation);

        await this.rateLimit.acquire(call);

        try {
            const result = await request();

            this.reconcileHeadersFromClient(null);

            return result;
        } catch (cause) {
            this.reconcileHeadersFromClient(cause);

            // Carry only the SANITIZED message as the exception context — never the raw
            // ccxt error — so a future AllExceptionsFilter can't serialize an
            // unredacted signature/API key out of `cause`.
            const sanitizedCause = sanitizeExchangeError(cause);

            this.logger.error(`ccxt ${operation} failed: ${sanitizedCause}`);

            throw new ExchangeRequestException(operation, sanitizedCause);
        }
    }

    // Maps a legacy `operation` / `operation:symbol` tag onto the typed
    // IRateLimitedCall. Order operations fail-fast (ADR 0030 §2.3); everything
    // else awaits up to 30s (the longest configured poll cadence). This keeps
    // the call-site refactor surgical — call sites still pass strings.
    private descriptorFromTag(tag: string): IRateLimitedCall {
        const colonIndex = tag.indexOf(':');
        const operation = colonIndex === -1 ? tag : tag.slice(0, colonIndex);
        const symbol = colonIndex === -1 ? null : tag.slice(colonIndex + 1);
        const isOrderOp = operation === 'createOrder' || operation === 'cancelOrder' || operation === 'cancelOrderByClientId';

        return buildRateLimitedCall({
            operation,
            isOrderOp,
            symbol,
            mode: isOrderOp ? 'fail-fast' : 'await',
            maxWaitMs: isOrderOp ? null : 30_000,
        });
    }

    // ccxt parks the most recent response headers on `last_response_headers`
    // (per-instance, not per-call) and on `httpHeaders` of the thrown ccxt
    // error. We try both. Parsing failures collapse to "no header" — the
    // limiter's local accounting is the runtime gate in that case.
    private reconcileHeadersFromClient(cause: unknown): void {
        const fromError = this.headersFromError(cause);
        const fromClient = (this.client as unknown as { last_response_headers?: Record<string, string> }).last_response_headers;
        const status = this.statusFromError(cause);

        if (fromError !== null) {
            this.rateLimit.reconcileFromHeaders(parseRateLimitHeaders(fromError, status));

            return;
        }

        if (fromClient !== undefined) {
            this.rateLimit.reconcileFromHeaders(parseRateLimitHeaders(fromClient, status));
        }
    }

    private headersFromError(cause: unknown): Record<string, string> | null {
        if (cause === null || typeof cause !== 'object') {
            return null;
        }

        const maybeHeaders = (cause as { httpHeaders?: Record<string, string> }).httpHeaders;

        if (maybeHeaders === undefined || typeof maybeHeaders !== 'object') {
            return null;
        }

        return maybeHeaders;
    }

    private statusFromError(cause: unknown): number | null {
        if (cause === null || typeof cause !== 'object') {
            return null;
        }

        const status = (cause as { httpStatusCode?: number; httpCode?: number }).httpStatusCode ?? (cause as { httpCode?: number }).httpCode;

        return typeof status === 'number' ? status : null;
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
            // Binance runs ccxt in TICK_SIZE precisionMode (binance.js parseMarket sets
            // precision.price = PRICE_FILTER.tickSize, precision.amount = LOT_SIZE.stepSize),
            // so precision.price/amount ARE the real increments (e.g. BTC 0.1, ETH 0.01) —
            // NOT decimal-place counts. limits.price.min is PRICE_FILTER.minPrice (a min
            // ALLOWED price, not the tick) and must NOT be used here. limits.cost.min is the
            // min order notional (MIN_NOTIONAL) and is the correct source for minNotional.
            tickSize: this.numberToString(market.precision?.price),
            stepSize: this.numberToString(market.precision?.amount),
            minNotional: this.numberToString(market.limits?.cost?.min),
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
            // ccxt FundingRate.fundingTimestamp is the current 8h settlement boundary.
            // Prefer it; fall back to nextFundingTimestamp, never the poll wall-clock —
            // a wall-clock value would defeat the per-settlement de-dup in funding_rates.
            fundingTimestampMs: fundingRate.fundingTimestamp ?? fundingRate.nextFundingTimestamp ?? null,
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

    // ccxt `Position` -> engine boundary type. `side` is the ccxt lower-case string
    // ('long' | 'short'); ReconciliationService normalises to PositionSideEnum. `contracts`
    // is magnitude (ccxt convention for unified position); we coerce to string at the
    // boundary so no float math precedes Decimal upstream (consistent with the rest of the
    // boundary mappers).
    private toPositionSnapshot(position: Position): IPositionSnapshot {
        return {
            symbol: position.symbol,
            side: position.side ?? '',
            qty: this.numberToString(position.contracts) ?? '0',
            entryPrice: this.numberToString(position.entryPrice),
            markPrice: this.numberToString(position.markPrice),
            liquidationPrice: this.numberToString(position.liquidationPrice),
            marginType: position.marginMode ?? null,
            leverage: this.numberToString(position.leverage),
            timestampMs: position.timestamp ?? null,
        };
    }

    // True iff the snapshot represents real exchange-side exposure. Some venues report
    // every hedged-mode slot even when flat; the reconciliation tick should only see
    // positions with non-zero magnitude.
    private isNonZeroPositionQty(snapshot: IPositionSnapshot): boolean {
        if (snapshot.qty === '0' || snapshot.qty === '') {
            return false;
        }

        return Number(snapshot.qty) !== 0;
    }

    // ccxt `Order` -> engine boundary type for the W4a OpenOrder snapshot. We only project
    // the fields the reconciliation service actually reads for case (e) protective drift;
    // richer Order fields stay accessible via `toOrderSnapshot` for the M5 path.
    private toOpenOrderSnapshot(order: Order): IOpenOrderSnapshot {
        // ccxt exposes reduceOnly under `order.reduceOnly` for unified perp orders; some
        // venues stash it under `info.reduceOnly`. Default `false` is safe: a missing flag
        // on a protective order is unusual (the bot's own attacher sets it), and the
        // reconciliation classifier prefers the `clientOrderId` suffix for matching anyway.
        const reduceOnly = this.resolveReduceOnly(order);

        return {
            exchangeOrderId: order.id ?? null,
            clientOrderId: order.clientOrderId ?? null,
            symbol: order.symbol,
            status: order.status ?? 'open',
            type: order.type ?? '',
            side: order.side ?? '',
            reduceOnly,
            timestampMs: order.timestamp ?? null,
        };
    }

    private resolveReduceOnly(order: Order): boolean {
        if (order.reduceOnly === true) {
            return true;
        }

        const rawInfo = order.info as { reduceOnly?: boolean } | undefined;

        return rawInfo?.reduceOnly === true;
    }

    // ccxt `FundingHistory` -> engine boundary type. ccxt's `amount` is a JS number
    // (signed at the exchange); stringify at the boundary so no float math precedes
    // Decimal upstream. `id` is the venue's tranId (ccxt unifies the Binance USDT-M
    // futures `tranId` field). `code` is the settlement asset code ('USDT' for USDT-M).
    private toFundingPaymentSnapshot(row: FundingHistory): IFundingPaymentSnapshot {
        return {
            id: row.id ?? null,
            symbol: row.symbol,
            fundingTimeMs: row.timestamp ?? 0,
            amount: this.numberToString(row.amount) ?? '0',
            asset: row.code ?? '',
        };
    }

    private toOrderSnapshot(order: Order): IExchangeOrderSnapshot {
        const feeCost = order.fee?.cost;
        const feeCurrency = order.fee?.currency ?? null;

        return {
            exchangeOrderId: order.id ?? null,
            clientOrderId: order.clientOrderId ?? null,
            symbol: order.symbol,
            status: order.status ?? 'open',
            type: order.type ?? '',
            side: order.side ?? '',
            price: this.numberToString(order.price),
            average: this.numberToString(order.average),
            amount: this.numberToString(order.amount),
            filled: this.numberToString(order.filled),
            remaining: this.numberToString(order.remaining),
            cost: this.numberToString(order.cost),
            fee: this.numberToString(feeCost),
            feeCurrency,
            timestampMs: order.timestamp ?? null,
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

    // M11a W1.2 (ADR 0028 §2.2). Per-field provider table: every field has an
    // explicit source endpoint + conservative default (missing-fields-fail-
    // allowlist). The mapper drops every field not in IKeyPermissionSnapshot.
    private toKeyPermissionSnapshot(restrictions: Record<string, unknown>, ipRestriction: Record<string, unknown>): IKeyPermissionSnapshot {
        const enableSpotAndMargin = this.boolFromPayload(restrictions, 'enableSpotAndMarginTrading', false);
        const enableSpotAlias = this.boolFromPayload(restrictions, 'enableSpot', false);

        return {
            enableReading: this.boolFromPayload(restrictions, 'enableReading', false),
            enableFutures: this.boolFromPayload(restrictions, 'enableFutures', false),
            // ADR §2.2: enableSpot = logical OR of the two field names.
            enableSpot: enableSpotAndMargin || enableSpotAlias,
            // Capabilities expected `false` default to `true` when the field
            // is missing — so a missing field fails the allowlist (ADR §2.2).
            enableWithdrawals: this.boolFromPayload(restrictions, 'enableWithdrawals', true),
            enableInternalTransfer: this.boolFromPayload(restrictions, 'enableInternalTransfer', true),
            permitsUniversalTransfer: this.boolFromPayload(restrictions, 'permitsUniversalTransfer', true),
            enableMargin: this.boolFromPayload(restrictions, 'enableMargin', true),
            enableVanillaOptions: this.boolFromPayload(restrictions, 'enableVanillaOptions', true),
            enableSubAccountManagement: this.boolFromPayload(restrictions, 'enableSubAccountManagement', true),
            // ipRestrict = logical AND across both endpoints (conservative if
            // either source disagrees).
            ipRestrict: this.boolFromPayload(restrictions, 'ipRestrict', false) && this.boolFromPayload(ipRestriction, 'ipRestrict', false),
            ipAllowList: this.parseIpAllowList(ipRestriction),
            tradingAuthorityExpirationTime: this.parseTradingAuthorityExpiration(restrictions),
            // boundary-clock read (audit-only, never used as a freshness gate).
            fetchedAtMs: Date.now(),
            sourceEndpoints: KEY_PERMISSION_SOURCE_ENDPOINTS,
        };
    }

    private boolFromPayload(payload: Record<string, unknown>, key: string, defaultIfMissing: boolean): boolean {
        const value = payload[key];

        if (value === undefined || value === null) {
            return defaultIfMissing;
        }

        return value === true;
    }

    private parseIpAllowList(ipRestriction: Record<string, unknown>): readonly string[] {
        const list = ipRestriction['ipList'];

        if (!Array.isArray(list)) {
            return [];
        }

        return list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    }

    // Binance docs: `tradingAuthorityExpirationTime` is epoch ms; `-1` means
    // "never expires" (ADR §2.2). The allowlist treats null as expired, so
    // the sentinel maps to null and fails the predicate.
    private parseTradingAuthorityExpiration(restrictions: Record<string, unknown>): number | null {
        const raw = restrictions['tradingAuthorityExpirationTime'];

        if (typeof raw !== 'number' || raw === TRADING_AUTHORITY_NEVER_EXPIRES_SENTINEL) {
            return null;
        }

        return raw;
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

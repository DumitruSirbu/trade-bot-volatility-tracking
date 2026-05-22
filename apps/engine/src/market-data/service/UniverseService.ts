import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CoinTierEnum } from '@bot/shared';

import {
    INSTRUMENT_REFRESHED_EVENT,
    MS_PER_HOUR,
    UNIVERSE_SYMBOL_ENTERED_EVENT,
    UNIVERSE_SYMBOL_LEFT_EVENT,
    UNIVERSE_SYMBOL_TIER_CHANGED_EVENT,
} from '../../common/const';
import { Money, MoneyValue, parseMoney } from '../../common/utils/money';
import { COIN_TIER_BY_MAX_RANK, STABLECOIN_BASE_SYMBOLS, UNIVERSE_MAX_SYMBOLS, UNIVERSE_MIN_QUOTE_VOLUME_USDT, UNIVERSE_REFRESH_CRON } from '../const';
import { EXCHANGE_CLIENT, IExchangeClient, IMarketInfo, ITickerSnapshot } from '../../exchange/interface';
import { IInstrumentRefreshedEvent, IUniverseEntry, IUniverseTransition } from '../interface';

// Owns the tradable universe: filters tradable USDT-M perps, ranks by 24h quote
// volume above a liquidity floor, keeps the top N, assigns coin tiers, and emits
// enter/leave transitions on each scheduled refresh. Tracks symbol-universe age
// (enteredAtMs) so fresh entrants — pump-risk — can be skipped downstream.
@Injectable()
export class UniverseService {
    private readonly logger = new Logger(UniverseService.name);

    private readonly entries = new Map<string, IUniverseEntry>();

    private linearPerpetualSymbols: Set<string> = new Set();

    // Market metadata by symbol (base/quote/status/precision), held so the universe can
    // emit INSTRUMENT_REFRESHED_EVENT with the full instrument shape (ADR 0002 §4).
    private readonly marketsBySymbol = new Map<string, IMarketInfo>();

    constructor(
        @Inject(EXCHANGE_CLIENT) private readonly exchangeClient: IExchangeClient,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    getEntries(): IUniverseEntry[] {
        return [...this.entries.values()];
    }

    getEntry(symbol: string): IUniverseEntry | null {
        return this.entries.get(symbol) ?? null;
    }

    isMember(symbol: string): boolean {
        return this.entries.has(symbol);
    }

    // Hours since the symbol entered the universe (fresh entrants are pump-risk).
    universeAgeHours(symbol: string, nowMs: number): number {
        const entry = this.entries.get(symbol);

        if (entry === undefined) {
            return 0;
        }

        return (nowMs - entry.enteredAtMs) / MS_PER_HOUR;
    }

    // Loads tradable markets once at startup so the ticker filter and ranking can
    // run; the membership snapshot itself is built by refresh() from ticker volume.
    async loadTradableSymbols(): Promise<void> {
        const markets = await this.exchangeClient.loadMarkets();
        const tradable = markets.filter((market) => this.isTradablePerpetual(market));

        this.linearPerpetualSymbols = new Set(tradable.map((market) => market.symbol));
        this.marketsBySymbol.clear();

        for (const market of markets) {
            this.marketsBySymbol.set(market.symbol, market);
        }

        this.logger.log(`Loaded ${this.linearPerpetualSymbols.size} tradable USDT-M perpetual markets`);
    }

    // Rebuilds membership from a fresh ticker batch (24h quote volume). Both the
    // startup seed and the cron refresh pass a REST full-snapshot (fetchTickers) so
    // tiers/ranks are never built from a partial !ticker@arr socket frame.
    refresh(tickers: ITickerSnapshot[], nowMs: number): void {
        const ranked = this.rankByVolume(tickers);
        const nextSymbols = new Set(ranked.map((entry) => entry.symbol));

        this.emitLeavers(nextSymbols);
        this.applyRanked(ranked, nowMs);

        this.logger.log(`Universe refreshed: ${this.entries.size} symbols (top ${UNIVERSE_MAX_SYMBOLS} by 24h volume)`);
    }

    @Cron(UNIVERSE_REFRESH_CRON)
    async scheduledRefresh(): Promise<void> {
        await this.loadTradableSymbols();

        const tickers = await this.exchangeClient.fetchTickers();

        this.refresh(tickers, Date.now());
    }

    private rankByVolume(tickers: ITickerSnapshot[]): IUniverseEntry[] {
        const floor = parseMoney(UNIVERSE_MIN_QUOTE_VOLUME_USDT);

        const eligible = tickers
            .filter((ticker) => this.linearPerpetualSymbols.has(ticker.symbol))
            .filter((ticker): ticker is ITickerSnapshot & { quoteVolume: string } => ticker.quoteVolume !== null)
            .map((ticker) => ({ symbol: ticker.symbol, quoteVolume: parseMoney(ticker.quoteVolume) }))
            .filter((candidate) => candidate.quoteVolume.greaterThanOrEqualTo(floor))
            .sort((left, right) => right.quoteVolume.comparedTo(left.quoteVolume))
            .slice(0, UNIVERSE_MAX_SYMBOLS);

        return eligible.map((candidate, index) => ({
            symbol: candidate.symbol,
            volumeRank: index + 1,
            tier: this.resolveTier(index + 1),
            quoteVolume24h: candidate.quoteVolume,
            enteredAtMs: 0,
        }));
    }

    private applyRanked(ranked: IUniverseEntry[], nowMs: number): void {
        for (const entry of ranked) {
            const existing = this.entries.get(entry.symbol);
            const tierChanged = existing !== undefined && existing.tier !== entry.tier;
            // A tier change opens a fresh membership window (ADR §4 point-in-time), so the
            // entered-at clock resets; otherwise carry the original entry time forward.
            const enteredAtMs = existing === undefined || tierChanged ? nowMs : existing.enteredAtMs;

            this.entries.set(entry.symbol, { ...entry, enteredAtMs });
            this.emitInstrumentRefreshed(entry);

            if (existing === undefined) {
                this.emitEntered(entry);

                continue;
            }

            if (tierChanged) {
                this.emitTierChanged(entry);
            }
        }
    }

    // Universe metadata is freshly ranked here (ADR §4) → emit so the persistence listener
    // UPSERTs `instruments` with the CURRENT tradable universe. tick_size/step_size/
    // min_notional are the real ccxt market limits (needed for M5 sizing/quantization).
    private emitInstrumentRefreshed(entry: IUniverseEntry): void {
        const market = this.marketsBySymbol.get(entry.symbol);

        if (market === undefined) {
            return;
        }

        this.emitInstrument(market, entry.quoteVolume24h, entry.tier, market.active && market.isLinearPerpetual);
    }

    private emitInstrument(market: IMarketInfo, volume24h: MoneyValue, coinTier: CoinTierEnum, isTradable: boolean): void {
        const event: IInstrumentRefreshedEvent = {
            symbol: market.symbol,
            base: market.base,
            quote: market.quote,
            status: market.active ? 'active' : 'inactive',
            tickSize: this.toMoneyOrZero(market.tickSize),
            stepSize: this.toMoneyOrZero(market.stepSize),
            minNotional: this.toMoneyOrZero(market.minNotional),
            isTradable,
            volume24h,
            coinTier,
        };

        this.eventEmitter.emit(INSTRUMENT_REFRESHED_EVENT, event);
    }

    private toMoneyOrZero(value: string | null): MoneyValue {
        if (value === null) {
            return new Money(0);
        }

        return parseMoney(value);
    }

    private emitTierChanged(entry: IUniverseEntry): void {
        const transition: IUniverseTransition = { symbol: entry.symbol, tier: entry.tier, volumeRank: entry.volumeRank };

        this.eventEmitter.emit(UNIVERSE_SYMBOL_TIER_CHANGED_EVENT, transition);
        this.logger.debug(`Universe TIER CHANGE ${entry.symbol} → ${entry.tier} (rank ${entry.volumeRank})`);
    }

    private emitLeavers(nextSymbols: Set<string>): void {
        for (const [symbol, entry] of this.entries) {
            if (!nextSymbols.has(symbol)) {
                this.entries.delete(symbol);
                this.emitInstrumentNonTradable(entry);
                this.emitLeft(entry);
            }
        }
    }

    // A symbol that left the universe is no longer tradable; `instruments` reflects the
    // CURRENT tradable set, so flip is_tradable=false (the row is retained for history).
    private emitInstrumentNonTradable(entry: IUniverseEntry): void {
        const market = this.marketsBySymbol.get(entry.symbol);

        if (market === undefined) {
            return;
        }

        this.emitInstrument(market, entry.quoteVolume24h, entry.tier, false);
    }

    private emitEntered(entry: IUniverseEntry): void {
        const transition: IUniverseTransition = { symbol: entry.symbol, tier: entry.tier, volumeRank: entry.volumeRank };

        this.eventEmitter.emit(UNIVERSE_SYMBOL_ENTERED_EVENT, transition);
        this.logger.debug(`Universe ENTER ${entry.symbol} (rank ${entry.volumeRank}, ${entry.tier})`);
    }

    private emitLeft(entry: IUniverseEntry): void {
        const transition: IUniverseTransition = { symbol: entry.symbol, tier: entry.tier, volumeRank: entry.volumeRank };

        this.eventEmitter.emit(UNIVERSE_SYMBOL_LEFT_EVENT, transition);
        this.logger.debug(`Universe LEAVE ${entry.symbol}`);
    }

    private resolveTier(rank: number): CoinTierEnum {
        for (const band of COIN_TIER_BY_MAX_RANK) {
            if (rank <= band.maxRank) {
                return band.tier;
            }
        }

        return CoinTierEnum.TIER_3;
    }

    private isTradablePerpetual(market: IMarketInfo): boolean {
        return market.active && market.isLinearPerpetual && !STABLECOIN_BASE_SYMBOLS.has(market.base);
    }
}

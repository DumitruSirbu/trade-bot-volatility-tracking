import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CoinTierEnum } from '@bot/shared';

import { UNIVERSE_SYMBOL_ENTERED_EVENT, UNIVERSE_SYMBOL_LEFT_EVENT } from '../../common/const';
import { parseMoney } from '../../common/utils/money';
import { COIN_TIER_BY_MAX_RANK, MS_PER_HOUR, UNIVERSE_MAX_SYMBOLS, UNIVERSE_MIN_QUOTE_VOLUME_USDT, UNIVERSE_REFRESH_CRON } from '../const';
import { EXCHANGE_CLIENT, IExchangeClient, IMarketInfo, ITickerSnapshot } from '../../exchange/interface';
import { IUniverseEntry, IUniverseTransition } from '../interface';

// Owns the tradable universe: filters tradable USDT-M perps, ranks by 24h quote
// volume above a liquidity floor, keeps the top N, assigns coin tiers, and emits
// enter/leave transitions on each scheduled refresh. Tracks symbol-universe age
// (enteredAtMs) so fresh entrants — pump-risk — can be skipped downstream.
@Injectable()
export class UniverseService {
    private readonly logger = new Logger(UniverseService.name);

    private readonly entries = new Map<string, IUniverseEntry>();

    private linearPerpetualSymbols: Set<string> = new Set();

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

        this.linearPerpetualSymbols = new Set(markets.filter((market) => this.isTradablePerpetual(market)).map((market) => market.symbol));

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
            const enteredAtMs = existing?.enteredAtMs ?? nowMs;

            this.entries.set(entry.symbol, { ...entry, enteredAtMs });

            if (existing === undefined) {
                this.emitEntered(entry);
            }
        }
    }

    private emitLeavers(nextSymbols: Set<string>): void {
        for (const [symbol, entry] of this.entries) {
            if (!nextSymbols.has(symbol)) {
                this.entries.delete(symbol);
                this.emitLeft(entry);
            }
        }
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
        return market.active && market.isLinearPerpetual;
    }
}

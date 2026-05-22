import { CoinTierEnum } from '@bot/shared';

import {
    CANDLE_1M_INTERVAL_MS,
    CANDLE_5M_INTERVAL_MS,
    EVENT_ANCHOR_VOLUME_RATIO,
    EVENT_ANCHORED_BAR_MAX,
    MS_PER_DAY,
    OPEN_INTEREST_HISTORY_RETENTION_MS,
    PRICE_TAPE_RETENTION_MS,
    SESSION_BAR_MAX,
} from '../const';
import { computeVwap } from '../indicator/computeVwap';
import { ICandle } from '../interface';
import { Money, MoneyValue } from '../../common/utils/money';
import { SymbolCandleState } from './SymbolCandleState';

interface IPricePoint {
    timestampMs: number;
    price: MoneyValue;
}

interface IAggressorTrade {
    timestampMs: number;
    buyVolume: MoneyValue;
    sellVolume: MoneyValue;
}

interface IOpenInterestPoint {
    timestampMs: number;
    value: MoneyValue;
}

// All rolling per-symbol state. Owns the 5m + 1m candle states (forming separate
// from closed, ADR §4), the session/event VWAP anchors, the recent price tape for
// breadth/stress, the aggressor buffer + OI history + funding + depth used to
// enrich a trigger, and the tier/escalation flags for the tiered subscription
// policy. This class holds state only; pure indicator math lives in indicator/.
export class SymbolMarketState {
    readonly candles5m: SymbolCandleState = new SymbolCandleState(CANDLE_5M_INTERVAL_MS);

    readonly candles1m: SymbolCandleState = new SymbolCandleState(CANDLE_1M_INTERVAL_MS);

    private readonly sessionBars: ICandle[] = [];

    private readonly eventAnchoredBars: ICandle[] = [];

    private readonly priceTape: IPricePoint[] = [];

    private readonly aggressorTrades: IAggressorTrade[] = [];

    private readonly openInterestHistory: IOpenInterestPoint[] = [];

    private fundingRate: number | null = null;

    private fundingRateAnnualized: number | null = null;

    private latestSpreadPct: number | null = null;

    private bookDepth10bpsUsdt: MoneyValue | null = null;

    private bookDepth50bpsUsdt: MoneyValue | null = null;

    private escalated = false;

    private sessionDayIndex: number | null = null;

    constructor(
        readonly symbol: string,
        private tier: CoinTierEnum,
    ) {}

    getTier(): CoinTierEnum {
        return this.tier;
    }

    setTier(tier: CoinTierEnum): void {
        this.tier = tier;
    }

    isEscalated(): boolean {
        return this.escalated;
    }

    setEscalated(escalated: boolean): void {
        this.escalated = escalated;
    }

    // Records a tick on both timeframes and the price tape. Returns the just-closed
    // 5-min bar (and updates session/event anchors when one closes), else null.
    ingestTick(price: MoneyValue, volumeDelta: MoneyValue, timestampMs: number): ICandle | null {
        this.candles1m.ingestTick(price, volumeDelta, timestampMs);

        const closed5m = this.candles5m.ingestTick(price, volumeDelta, timestampMs);

        this.recordPricePoint(price, timestampMs);

        if (closed5m !== null) {
            this.onBarClosed(closed5m);
        }

        return closed5m;
    }

    // Wall-clock close path (live timer): graduates the forming 5-min (and 1-min)
    // candle if its bucket has elapsed, independent of tick arrival. Runs the same
    // onBarClosed bookkeeping as ingestTick so the downstream recompute is identical.
    // Returns the just-closed 5-min bar, else null.
    closeElapsedBars(nowMs: number): ICandle | null {
        this.candles1m.closeFormingIfElapsed(nowMs);

        const closed5m = this.candles5m.closeFormingIfElapsed(nowMs);

        if (closed5m !== null) {
            this.onBarClosed(closed5m);
        }

        return closed5m;
    }

    getSessionBars(): ICandle[] {
        return this.sessionBars;
    }

    // Bar-aligned 5-min move: latest closed bar's close vs the prior closed bar's.
    // Matches the coin's snapshot.fiveMinMovePct definition exactly, so the BTC-
    // correlation idiosyncrasy filter compares numerator and denominator over one
    // horizon — and reproduces in backtest (no wall-clock price-tape window).
    barToBarMovePct(): number {
        const bars = this.candles5m.getClosedBars();

        if (bars.length < 2) {
            return 0;
        }

        const previous = bars[bars.length - 2].close;
        const latest = bars[bars.length - 1].close;

        if (previous.isZero()) {
            return 0;
        }

        return latest.minus(previous).dividedBy(previous).times(100).toNumber();
    }

    getEventAnchoredVwap(): MoneyValue {
        if (this.eventAnchoredBars.length === 0) {
            const latest = this.candles5m.getLatestClosedBar();

            return latest === null ? new Money(0) : latest.close;
        }

        return computeVwap(this.eventAnchoredBars);
    }

    // % price move over the lookback window from the price tape (breadth/stress).
    movePctOverWindow(windowMs: number, nowMs: number): number | null {
        const cutoff = nowMs - windowMs;
        const oldest = this.priceTape.find((point) => point.timestampMs >= cutoff);
        const latest = this.priceTape[this.priceTape.length - 1];

        if (oldest === undefined || latest === undefined || oldest.price.isZero()) {
            return null;
        }

        return latest.price.minus(oldest.price).dividedBy(oldest.price).times(100).toNumber();
    }

    recordAggressorTrade(buyVolume: MoneyValue, sellVolume: MoneyValue, timestampMs: number): void {
        this.aggressorTrades.push({ timestampMs, buyVolume, sellVolume });
    }

    // buy / (buy + sell) over the trigger window; null when no trades captured.
    aggressorBuyRatio(windowMs: number, nowMs: number): number | null {
        const cutoff = nowMs - windowMs;
        let buy = new Money(0);
        let sell = new Money(0);

        for (const trade of this.aggressorTrades) {
            if (trade.timestampMs >= cutoff) {
                buy = buy.plus(trade.buyVolume);
                sell = sell.plus(trade.sellVolume);
            }
        }

        const total = buy.plus(sell);

        if (total.isZero()) {
            return null;
        }

        return buy.dividedBy(total).toNumber();
    }

    pruneAggressorTrades(windowMs: number, nowMs: number): void {
        const cutoff = nowMs - windowMs;

        while (this.aggressorTrades.length > 0 && this.aggressorTrades[0].timestampMs < cutoff) {
            this.aggressorTrades.shift();
        }
    }

    recordOpenInterest(value: MoneyValue, timestampMs: number): void {
        this.openInterestHistory.push({ timestampMs, value });

        while (this.openInterestHistory.length > 0 && timestampMs - this.openInterestHistory[0].timestampMs > OPEN_INTEREST_HISTORY_RETENTION_MS) {
            this.openInterestHistory.shift();
        }
    }

    latestOpenInterest(): MoneyValue | null {
        if (this.openInterestHistory.length === 0) {
            return null;
        }

        return this.openInterestHistory[this.openInterestHistory.length - 1].value;
    }

    openInterestChangePct(windowMs: number, nowMs: number): number | null {
        const cutoff = nowMs - windowMs;
        const reference = [...this.openInterestHistory].reverse().find((point) => point.timestampMs <= cutoff);
        const latest = this.latestOpenInterest();

        if (reference === undefined || latest === null || reference.value.isZero()) {
            return null;
        }

        return latest.minus(reference.value).dividedBy(reference.value).times(100).toNumber();
    }

    setFunding(rate: number | null, annualized: number | null): void {
        this.fundingRate = rate;
        this.fundingRateAnnualized = annualized;
    }

    getFundingRate(): number | null {
        return this.fundingRate;
    }

    getFundingRateAnnualized(): number | null {
        return this.fundingRateAnnualized;
    }

    setDepth(spreadPct: number | null, depth10bps: MoneyValue | null, depth50bps: MoneyValue | null): void {
        this.latestSpreadPct = spreadPct;
        this.bookDepth10bpsUsdt = depth10bps;
        this.bookDepth50bpsUsdt = depth50bps;
    }

    getSpreadPct(): number | null {
        return this.latestSpreadPct;
    }

    getBookDepth10bpsUsdt(): MoneyValue | null {
        return this.bookDepth10bpsUsdt;
    }

    getBookDepth50bpsUsdt(): MoneyValue | null {
        return this.bookDepth50bpsUsdt;
    }

    private onBarClosed(closed: ICandle): void {
        this.resetSessionIfNewDay(closed);
        this.sessionBars.push(closed);

        if (this.sessionBars.length > SESSION_BAR_MAX) {
            this.sessionBars.shift();
        }

        this.eventAnchoredBars.push(closed);

        if (this.eventAnchoredBars.length > EVENT_ANCHORED_BAR_MAX) {
            this.eventAnchoredBars.shift();
        }

        this.maybeReanchorOnEvent(closed);
    }

    // Session VWAP is per-UTC-day: when a closed bar's close time crosses into a new
    // UTC day, drop the prior session's bars so vwapSession reflects only the current
    // session (not all history). Keyed off the BAR's close time — never wall-clock —
    // so live and backtest reset on the same boundary.
    private resetSessionIfNewDay(closed: ICandle): void {
        const closeTimeMs = closed.openTimeMs + CANDLE_5M_INTERVAL_MS;
        const dayIndex = Math.floor(closeTimeMs / MS_PER_DAY);

        if (this.sessionDayIndex !== null && dayIndex > this.sessionDayIndex) {
            this.sessionBars.length = 0;
        }

        this.sessionDayIndex = dayIndex;
    }

    // A high-volume regime shift re-anchors the event-anchored VWAP: keep only the
    // bar that triggered it forward (M1 "VWAP anchoring" — event_anchored).
    private maybeReanchorOnEvent(closed: ICandle): void {
        const average = this.averageRecentVolume();

        if (average.isZero()) {
            return;
        }

        const ratio = closed.volume.dividedBy(average).toNumber();

        if (ratio >= EVENT_ANCHOR_VOLUME_RATIO) {
            this.eventAnchoredBars.splice(0, this.eventAnchoredBars.length - 1);
        }
    }

    private averageRecentVolume(): MoneyValue {
        const bars = this.candles5m.getClosedBars();

        if (bars.length === 0) {
            return new Money(0);
        }

        const total = bars.reduce((sum, bar) => sum.plus(bar.volume), new Money(0));

        return total.dividedBy(bars.length);
    }

    private recordPricePoint(price: MoneyValue, timestampMs: number): void {
        this.priceTape.push({ timestampMs, price });

        const cutoff = timestampMs - PRICE_TAPE_RETENTION_MS;

        while (this.priceTape.length > 0 && this.priceTape[0].timestampMs < cutoff) {
            this.priceTape.shift();
        }
    }
}

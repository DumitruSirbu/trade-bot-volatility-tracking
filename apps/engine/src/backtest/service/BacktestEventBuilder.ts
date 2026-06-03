import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, IVolatilityDetectedEvent } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';
import { computeRegimeLabel } from '../../market-data/indicator/computeRegimeLabel';
import { IIndicatorSnapshot } from '../../market-data/interface';

// Idiosyncrasy denominator floor: prevents 0/0 when both moves are exactly zero. Tiny —
// 0.0001 — so it does not bias the score for realistic inputs.
const IDIOSYNCRASY_EPSILON = 0.0001;

// Per-bar replay context the runner threads into the event builder (ADR 0015 §2.2). Fields
// whose live source is cross-symbol aggregation (same_bar_trigger_count) or sub-minute data
// the backtest does not load (btc_1m_move_pct) arrive as neutral sentinels; the caller marks
// the resulting trade `lowFidelity` so M8 analytics can distinguish replay degradation from
// live. market_breadth_5m_up_pct's neutral sentinel is the midpoint MARKET_BREADTH_NEUTRAL_PCT
// (50), NOT 0 — since M19 the breadth halt fires on distance from 50, so a 0 would falsely trip
// it (see BacktestRunnerService).
export interface IBacktestEventContext {
    readonly coinTier: CoinTierEnum;
    readonly universeAgeHours: number;
    readonly coinVolumeRank: number;
    readonly oiValue: MoneyValue | null;
    readonly oiChange5mPct: number;
    readonly oiChange15mPct: number;
    readonly fundingRate: number;
    readonly fundingRateAnnualized: number;
    readonly btc5mMovePct: number;
    readonly eth5mMovePct: number;
    readonly btc1mMovePct: number;
    readonly bidAskSpreadPct: number;
    readonly bookDepth10bpsUsdt: MoneyValue | null;
    readonly bookDepth50bpsUsdt: MoneyValue | null;
    readonly marketBreadth5mUpPct: number;
    readonly sameBarTriggerCount: number;
    readonly aggTradeBuyVolumeRatio: number;
}

// Builds an IVolatilityDetectedEvent for the backtest replay from a closed bar's indicator
// snapshot plus context data (OI, funding, book, BTC reference, universe). Pure function —
// no clock, no random, no I/O — so the same inputs always produce the same event payload
// for the strategy + gate to consume.
//
// The event's `flowType` field is left UNKNOWN here; the orchestrator stamps it via
// classifyFlowType (matches StrategyService.onVolatilityDetected). regime_label is derived
// directly from ADX + DI± so it matches the persisted snapshot regardless of whether the
// upstream event source carries one.
export function buildBacktestEvent(snapshot: IIndicatorSnapshot, barOpenTimeMs: number, context: IBacktestEventContext): IVolatilityDetectedEvent {
    return {
        symbol: snapshot.symbol,
        side: resolveDeviationSide(snapshot.vwapDeviationPct),
        entryCandleOpenTime: barOpenTimeMs,
        eventId: `${snapshot.symbol}:${barOpenTimeMs}`,

        vwapSession: snapshot.vwapSession.toFixed(18),
        vwap20bar: snapshot.vwap20bar.toFixed(18),
        vwapAnchorType: snapshot.activeVwapAnchorType,
        vwapDeviationPct: snapshot.vwapDeviationPct,
        vwapDeviationSigma: snapshot.vwapDeviationSigma,

        volumeRatio: snapshot.volumeRatio,
        volume20barAvg: snapshot.volume20barAvg.toFixed(18),

        atr14: snapshot.atr14.toFixed(18),
        adx14: snapshot.adx14,
        adxDiPlus: snapshot.adxDiPlus,
        adxDiMinus: snapshot.adxDiMinus,
        rsi14: snapshot.rsi14,
        bollingerUpper: snapshot.bollingerUpper.toFixed(18),
        bollingerLower: snapshot.bollingerLower.toFixed(18),
        bollingerPctB: snapshot.bollingerPctB,

        btc5mMovePct: context.btc5mMovePct,
        idiosyncrasyScore: computeIdiosyncrasyScore(snapshot.fiveMinMovePct, context.btc5mMovePct),

        coinTier: context.coinTier,
        coinVolumeRank: context.coinVolumeRank,
        symbolUniverseAgeHours: context.universeAgeHours,

        fundingRate: context.fundingRate,
        fundingRateAnnualized: context.fundingRateAnnualized,
        openInterest: context.oiValue !== null ? context.oiValue.toFixed(18) : '0',
        openInterestChange5mPct: context.oiChange5mPct,
        openInterestChange15mPct: context.oiChange15mPct,
        aggTradeBuyVolumeRatio: context.aggTradeBuyVolumeRatio,

        bidAskSpreadPct: context.bidAskSpreadPct,
        bookDepth10bpsUsdt: context.bookDepth10bpsUsdt !== null ? context.bookDepth10bpsUsdt.toFixed(18) : '0',
        bookDepth50bpsUsdt: context.bookDepth50bpsUsdt !== null ? context.bookDepth50bpsUsdt.toFixed(18) : '0',

        regimeLabel: computeRegimeLabel(snapshot.adx14, snapshot.adxDiPlus, snapshot.adxDiMinus),
        marketBreadth5mUpPct: context.marketBreadth5mUpPct,
        sameBarTriggerCount: context.sameBarTriggerCount,
        btc1mMovePct: context.btc1mMovePct,
        eth5mMovePct: context.eth5mMovePct,

        // Neutral placeholder — the orchestrator overwrites this via classifyFlowType
        // before the event reaches the strategy or the gate (mirrors live StrategyService
        // stamping). FlowTypeEnum has no UNKNOWN member, so LOW_QUALITY_NOISE is the most
        // conservative default: any uncovered code path that reads this pre-stamp will
        // route as the lowest-quality flow.
        flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
    };
}

function resolveDeviationSide(vwapDeviationPct: number): DeviationSideEnum {
    if (vwapDeviationPct > 0) {
        return DeviationSideEnum.ABOVE;
    }

    return DeviationSideEnum.BELOW;
}

// Idiosyncrasy score: how independent the symbol's 5m move is from BTC's 5m move. Higher
// = more idiosyncratic (eligible for slot A/B); lower = more BTC-correlated (slot C).
// When BTC's move is exactly zero (no reference available), the score collapses to zero —
// without a reference we cannot claim idiosyncrasy.
function computeIdiosyncrasyScore(symbol5mMovePct: number, btc5mMovePct: number): number {
    if (btc5mMovePct === 0) {
        return 0;
    }

    const numerator = Math.abs(symbol5mMovePct - btc5mMovePct);
    const denominator = Math.abs(symbol5mMovePct) + Math.abs(btc5mMovePct) + IDIOSYNCRASY_EPSILON;
    const raw = numerator / denominator;

    return clampUnitInterval(raw);
}

function clampUnitInterval(value: number): number {
    if (value < 0) {
        return 0;
    }

    if (value > 1) {
        return 1;
    }

    return value;
}

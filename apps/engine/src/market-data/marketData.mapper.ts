import { FlowTypeEnum, IVolatilityDetectedEvent } from '@bot/shared';

import { formatMoney, MoneyValue } from '../common/utils/money';
import { IVolatilityEventInputs } from './interface';

// Builds the enriched volatility.detected payload. flowType is the M1 placeholder
// (FlowTypeEnum.UNCLASSIFIED) — the flow classifier lands in M3.
export function toVolatilityDetectedEvent(inputs: IVolatilityEventInputs): IVolatilityDetectedEvent {
    const { snapshot, flow } = inputs;

    return {
        symbol: snapshot.symbol,
        side: inputs.side,
        entryCandleOpenTime: snapshot.closedBarOpenTimeMs,

        vwapSession: formatMoney(snapshot.vwapSession),
        vwap20bar: formatMoney(snapshot.vwap20bar),
        vwapAnchorType: snapshot.activeVwapAnchorType,
        vwapDeviationPct: snapshot.vwapDeviationPct,
        vwapDeviationSigma: snapshot.vwapDeviationSigma,

        volumeRatio: snapshot.volumeRatio,
        volume20barAvg: formatMoney(snapshot.volume20barAvg),

        atr14: formatMoney(snapshot.atr14),
        adx14: snapshot.adx14,
        adxDiPlus: snapshot.adxDiPlus,
        adxDiMinus: snapshot.adxDiMinus,
        rsi14: snapshot.rsi14,
        bollingerUpper: formatMoney(snapshot.bollingerUpper),
        bollingerLower: formatMoney(snapshot.bollingerLower),
        bollingerPctB: snapshot.bollingerPctB,

        btc5mMovePct: inputs.btc5mMovePct,
        idiosyncrasyScore: inputs.idiosyncrasyScore,

        coinTier: inputs.coinTier,
        coinVolumeRank: inputs.coinVolumeRank,
        symbolUniverseAgeHours: inputs.symbolUniverseAgeHours,

        fundingRate: flow.fundingRate ?? 0,
        fundingRateAnnualized: flow.fundingRateAnnualized ?? 0,
        openInterest: formatNullableMoney(flow.openInterest),
        openInterestChange5mPct: flow.openInterestChange5mPct ?? 0,
        openInterestChange15mPct: flow.openInterestChange15mPct ?? 0,
        aggTradeBuyVolumeRatio: flow.aggTradeBuyVolumeRatio ?? 0,

        bidAskSpreadPct: flow.bidAskSpreadPct ?? 0,
        bookDepth10bpsUsdt: formatNullableMoney(flow.bookDepth10bpsUsdt),
        bookDepth50bpsUsdt: formatNullableMoney(flow.bookDepth50bpsUsdt),

        regimeLabel: inputs.regimeLabel,
        marketBreadth5mUpPct: inputs.marketBreadth5mUpPct,
        sameBarTriggerCount: inputs.sameBarTriggerCount,
        btc1mMovePct: inputs.btc1mMovePct,
        eth5mMovePct: inputs.eth5mMovePct,

        flowType: FlowTypeEnum.UNCLASSIFIED,
    };
}

function formatNullableMoney(value: MoneyValue | null): string {
    if (value === null) {
        return '0';
    }

    return formatMoney(value);
}

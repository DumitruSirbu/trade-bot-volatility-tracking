import { CoinTierEnum } from '../enum/CoinTierEnum.js';
import { DeviationSideEnum } from '../enum/DeviationSideEnum.js';
import { FlowTypeEnum } from '../enum/FlowTypeEnum.js';
import { RegimeLabelEnum } from '../enum/RegimeLabelEnum.js';
import { VwapAnchorTypeEnum } from '../enum/VwapAnchorTypeEnum.js';

export interface IVolatilityDetectedEvent {
    // identity / event meta
    symbol: string;
    side: DeviationSideEnum;          // deviation direction, NOT trade direction
    entryCandleOpenTime: number;      // closed-bar open time, epoch ms

    // VWAP / deviation
    vwapSession: string;              // decimal-as-string (price)
    vwap20bar: string;                // decimal-as-string (price)
    vwapAnchorType: VwapAnchorTypeEnum;
    vwapDeviationPct: number;         // % deviation (not money)
    vwapDeviationSigma: number;       // normalized distance (not a probability)

    // volume
    volumeRatio: number;              // currentBarVolume / 20bar avg
    volume20barAvg: string;           // decimal-as-string (base-asset volume)

    // indicators
    atr14: string;                    // decimal-as-string (price units)
    adx14: number;
    adxDiPlus: number;
    adxDiMinus: number;
    rsi14: number;
    bollingerUpper: string;           // decimal-as-string (price)
    bollingerLower: string;           // decimal-as-string (price)
    bollingerPctB: number;

    // BTC reference / idiosyncrasy
    btc5mMovePct: number;
    idiosyncrasyScore: number;        // clamped [0,1]

    // universe / liquidity context
    coinTier: CoinTierEnum;
    coinVolumeRank: number;
    symbolUniverseAgeHours: number;

    // funding / flow context
    fundingRate: number;              // periodic rate (ratio, not money)
    fundingRateAnnualized: number;
    openInterest: string;             // decimal-as-string (contracts/notional)
    openInterestChange5mPct: number;
    openInterestChange15mPct: number;
    aggTradeBuyVolumeRatio: number;   // buy vol / (buy+sell) over trigger window

    // order-book / spread (captured around trigger)
    bidAskSpreadPct: number;
    bookDepth10bpsUsdt: string;       // decimal-as-string (USDT notional)
    bookDepth50bpsUsdt: string;       // decimal-as-string (USDT notional)

    // breadth / stress / regime
    regimeLabel: RegimeLabelEnum;
    marketBreadth5mUpPct: number;
    sameBarTriggerCount: number;
    btc1mMovePct: number;
    eth5mMovePct: number;

    // classified in M3 — placeholder in M1
    flowType: FlowTypeEnum;
}

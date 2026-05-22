import { CoinTierEnum, DeviationSideEnum, RegimeLabelEnum } from '@bot/shared';

import { IFlowLiquidityContext } from './IFlowLiquidityContext';
import { IIndicatorSnapshot } from './IIndicatorSnapshot';

// Inputs assembled by the orchestrator at trigger time; the mapper turns them into
// the wire payload. Money/price fields serialize as decimal strings; scores/ratios/
// counts/ages stay numbers; nulls (escalated data not yet captured) default to 0.
export interface IVolatilityEventInputs {
    snapshot: IIndicatorSnapshot;
    side: DeviationSideEnum;
    coinTier: CoinTierEnum;
    coinVolumeRank: number;
    symbolUniverseAgeHours: number;
    regimeLabel: RegimeLabelEnum;
    btc5mMovePct: number;
    btc1mMovePct: number;
    eth5mMovePct: number;
    idiosyncrasyScore: number;
    marketBreadth5mUpPct: number;
    sameBarTriggerCount: number;
    flow: IFlowLiquidityContext;
}

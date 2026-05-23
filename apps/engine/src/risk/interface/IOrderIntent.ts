import { CoinTierEnum, CorrelationModeEnum, OrderIntentActionEnum, PositionSideEnum } from '@bot/shared';

import { IProposedExit, IOpenPositionState } from '../../strategy/interface';
import { DecimalValue, MoneyValue } from '../../common/utils/money';
import { IIntentSizing } from './IIntentSizing';

// The gate's input (ADR 0004 §1). The orchestrator assembles it from the M3 ISignal +
// PositionSizer output + slot/correlation context. Engine-internal (like ISignal) because
// it carries MoneyValue; the dashboard reads the persisted decisions/positions rows.
export interface IOrderIntent {
    readonly intentAction: OrderIntentActionEnum; // open|add|reduce|close|flatten (§2)
    readonly symbol: string;
    readonly eventId: string; // ties back to the trigger / decision
    readonly tradeSide: PositionSideEnum; // long|short, set by the strategy; gate NEVER flips
    readonly signalScore: number; // 0-100, drives same-bar candidate selection (§4)
    readonly correlationMode: CorrelationModeEnum; // idiosyncratic|correlated (drives slot eligibility)
    readonly coinTier: CoinTierEnum;
    readonly idiosyncrasyScore: number; // clamped [0,1], drives A/B eligibility
    readonly entryPrice: MoneyValue; // deterministic reference price (bar close)
    readonly maintenanceMarginRate: DecimalValue; // fraction of notional; locates the real liquidation price (§8)
    readonly proposedExit: IProposedExit; // strategy SL/TP/time-stop (ADR 0003 §3)
    readonly openPosition: IOpenPositionState | null; // for add/reduce/close; null for open
    readonly sizing: IIntentSizing; // §8 concrete decimal sizing
}

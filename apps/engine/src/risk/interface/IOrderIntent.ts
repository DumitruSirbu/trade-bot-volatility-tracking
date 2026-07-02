import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    RebalanceTriggerSourceEnum,
} from '@bot/shared';

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
    // Bar-close reference price used for SL/TP DISTANCE math (ADR 0003 §3, ADR 0004 §8).
    // NOT the IOC-limit-price reference — see midAtTrigger for that (ADR 0005 §2).
    readonly entryPrice: MoneyValue;
    // The SIGNAL REFERENCE price (reconstructReferencePrice(event)), the
    // same anchor the cores used to compute proposedExit's SL/TP. The gate's R:R geometry
    // (isRewardRiskTooLow) anchors to THIS, never to entryPrice. In live entryPrice already
    // equals this reference; in backtest entryPrice is the nextBarOpen fill estimate (different
    // value) while referencePrice stays the signal reference — so the same signal yields the
    // same gate R:R in live and backtest (invariant 7). Engine-internal — no shared change.
    readonly referencePrice: MoneyValue;
    // Trigger-time order-book mid carried on the intent (ADR 0005 §2). Sourced by the
    // strategy from the persisted book_snapshots row stamped at the trigger event; the
    // orchestrator passes it through and the executor's OrderPolicyRouter uses it as the
    // entryRef in the IOC-limit formula. Kept separate from `entryPrice` so SL/TP distance
    // math (bar close) and IOC microstructure math (book mid) never get cross-wired.
    readonly midAtTrigger: MoneyValue;
    readonly maintenanceMarginRate: DecimalValue; // fraction of notional; locates the real liquidation price (§8)
    readonly proposedExit: IProposedExit; // strategy SL/TP/time-stop (ADR 0003 §3)
    readonly openPosition: IOpenPositionState | null; // for add/reduce/close; null for open
    readonly sizing: IIntentSizing; // §8 concrete decimal sizing
    // Classified flow type stamped by the strategy onto decisions.flow_type and threaded
    // through the gate (pass-through) → executor. The executor reads this directly as a
    // row key into the order-policy matrix (ADR 0005 §1) — no `resolveFlowType` heuristic.
    readonly flowType: FlowTypeEnum;
    // Optional explicit exit reason for reduce-family intents (M6 W3, ADR 0011 §4). When the
    // LocalProtectiveMonitor synthesises a CLOSE intent on SL/TP breach, it stamps
    // `stop_loss` or `take_profit` here so the executor's `exitReasonForIntent` can record
    // the precise reason on the position row. Strategy-originated closes (signal exit) leave
    // this undefined; the executor falls back to the action-driven mapping. Engine-internal
    // field — no shared-contract change.
    readonly exitReason?: ExitReasonEnum;
    // Rebalance provenance for a momentum open (ADR 0048 M50c). Set by the momentum orchestrator
    // to 'scheduled' or 'manual'; the executor persists it to positions.trigger_source so the
    // analysis surfaces can fence manual (operator smoke-test / ad-hoc) trades out of the primary
    // calibration aggregation. Left undefined by the VWAP path (StrategyService), which has no
    // rebalance-trigger concept — that absence persists as NULL. Engine-internal — no shared change.
    readonly triggerSource?: RebalanceTriggerSourceEnum;
}

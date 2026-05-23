import { CoinTierEnum, OrderIntentActionEnum, OrderPolicyEnum, PositionSideEnum, StrategyDirectionEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { Money, MoneyValue } from '../../common/utils/money';
import { IOrderIntent } from '../../risk/interface';
import { DEFAULT_MAX_SLIPPAGE_OF_SL_PCT, MAX_SLIPPAGE_TIER_PCT, ORDER_TIMEOUT_MS } from '../const';
import { isCatalogued, IOrderPolicyMatrixKey, lookupOrderPolicy } from '../const/orderPolicyMatrix';
import { IOrderPlanInternal } from '../interface';

// Pure router (ADR 0005 §1/§2). Selects the order policy from the matrix and computes a
// concrete plan (limit price, timeout, slippage cap, reduceOnly) for the submitter. No I/O,
// no clock — same intent + market state in produces the same plan in M7 replay.
//
// Inputs:
//   - intent: the approved IOrderIntent. Carries action, side, tier, sizing, exit, AND the
//     flow_type + midAtTrigger fields the executor needs (ADR 0005 §1/§2). The router reads
//     flowType DIRECTLY off the intent — no resolveFlowType heuristic (live-vs-backtest
//     contract C5).
//   - strategyDirection: the active strategy's direction. For HYBRID the orchestrator
//     resolves the leg before calling here (mean_reversion or momentum).
//   - maxSlippageOfSlPct: optional override from `strategy_versions.params` (% of SL distance
//     the executor may pay as entry slippage). Defaults to DEFAULT_MAX_SLIPPAGE_OF_SL_PCT.
@Injectable()
export class OrderPolicyRouter {
    private readonly logger = new Logger(OrderPolicyRouter.name);

    plan(input: IOrderPlanInput): IOrderPlanInternal {
        const key: IOrderPolicyMatrixKey = {
            intentAction: input.intent.intentAction,
            strategyDirection: input.strategyDirection,
            coinTier: input.intent.coinTier,
            flowType: input.intent.flowType,
        };
        const policy = lookupOrderPolicy(key);

        if (!isCatalogued(key)) {
            this.logger.warn(
                `policy matrix fallback used: action=${key.intentAction} dir=${key.strategyDirection} ` +
                    `tier=${key.coinTier} flow=${key.flowType} -> policy=${policy} (catalog miss)`,
            );
        }

        return this.buildPlan(policy, input);
    }

    private buildPlan(policy: OrderPolicyEnum, input: IOrderPlanInput): IOrderPlanInternal {
        const timeoutMs = ORDER_TIMEOUT_MS[policy];

        if (policy === OrderPolicyEnum.REDUCE_MARKET) {
            return {
                policy,
                limitPrice: input.intent.midAtTrigger, // unused for market orders, kept for audit
                timeoutMs,
                slippageCapPct: new Money(0),
                reduceOnly: true,
            };
        }

        const slippageCapPct = this.computeSlippageCap(input);
        const limitPrice = this.computeLimitPrice(policy, input, slippageCapPct);
        const reduceOnly = this.isReduceOnly(input.intent.intentAction);

        return {
            policy,
            limitPrice,
            timeoutMs,
            slippageCapPct,
            reduceOnly,
        };
    }

    // Effective cap = min(tierCap, slDistanceFraction × maxSlOfSlPct) (ADR 0005 §2). The SL
    // distance is anchored on entryPrice (bar close), not midAtTrigger — preserves the
    // strategy's SL distance math (ADR 0003 §3 / ADR 0004 §8). The IOC limit price math
    // below uses midAtTrigger as entryRef; the two reference points are intentionally
    // distinct (ADR 0005 §2).
    private computeSlippageCap(input: IOrderPlanInput): MoneyValue {
        const tierCapPct = new Money(MAX_SLIPPAGE_TIER_PCT[input.intent.coinTier]);
        const maxSlOfSlPct = input.maxSlippageOfSlPct ?? new Money(DEFAULT_MAX_SLIPPAGE_OF_SL_PCT);
        const stopDistance = input.intent.entryPrice.minus(input.intent.proposedExit.stopLossPrice).abs();
        const slDistancePct = stopDistance.dividedBy(input.intent.entryPrice).times(100);
        const slBoundedCap = slDistancePct.times(maxSlOfSlPct).dividedBy(100);

        return Money.min(tierCapPct, slBoundedCap);
    }

    // ADR 0005 §2: IOC limit price math is `midAtTrigger * (1 ± slippageCapPct)` — NOT
    // entryPrice (bar close). The live executor pegs POST_ONLY_MAKER to best-bid/best-ask
    // at submit time (ADR 0005 §2 + must-fix #9 — see ProtectiveOrderAttacher / submitter
    // book-peg logic); this pure router returns midAtTrigger as the deterministic
    // reference both live (clamped at submit) and M7 backtest can reproduce.
    private computeLimitPrice(policy: OrderPolicyEnum, input: IOrderPlanInput, slippageCapPct: MoneyValue): MoneyValue {
        if (policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC) {
            return this.marketableLimitPrice(input, slippageCapPct);
        }

        return input.intent.midAtTrigger;
    }

    private marketableLimitPrice(input: IOrderPlanInput, slippageCapPct: MoneyValue): MoneyValue {
        const slippageFraction = slippageCapPct.dividedBy(100);
        const isLong = input.intent.tradeSide === PositionSideEnum.LONG;
        const adverseMultiplier = isLong ? new Money(1).plus(slippageFraction) : new Money(1).minus(slippageFraction);

        return input.intent.midAtTrigger.times(adverseMultiplier);
    }

    private isReduceOnly(action: OrderIntentActionEnum): boolean {
        return action === OrderIntentActionEnum.REDUCE || action === OrderIntentActionEnum.CLOSE || action === OrderIntentActionEnum.FLATTEN;
    }
}

export interface IOrderPlanInput {
    readonly intent: IOrderIntent;
    readonly strategyDirection: StrategyDirectionEnum;
    readonly maxSlippageOfSlPct: MoneyValue | null;
}

// Helper so the test surface and the router agree on what a tier cap is. Pure, exported for
// the M7 replay router and the QA wave to import without leaking into other modules.
export function tierSlippageCapPct(coinTier: CoinTierEnum): MoneyValue {
    return new Money(MAX_SLIPPAGE_TIER_PCT[coinTier]);
}

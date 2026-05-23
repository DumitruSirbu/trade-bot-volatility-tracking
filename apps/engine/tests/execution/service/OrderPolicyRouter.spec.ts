/**
 * OrderPolicyRouter — policy matrix (ADR 0005 §1/§2) + slippage cap math.
 *
 * Coverage:
 *   - De-risking actions (REDUCE/CLOSE/FLATTEN) always yield REDUCE_MARKET, all tiers/flows
 *   - OPEN/ADD mean-reversion tier-1 forced-exhaustion → MARKETABLE_LIMIT_IOC
 *   - OPEN/ADD mean-reversion tier-2/3 forced-exhaustion → POST_ONLY_MAKER (not IOC)
 *   - OPEN/ADD mean-reversion non-forced-exhaustion flows → POST_ONLY_MAKER
 *   - OPEN/ADD momentum all tiers/flows → MARKETABLE_LIMIT_IOC
 *   - Slippage cap = min(tierCap, slDistance × maxSlOfSlPct / 100)
 *   - Cancel timeouts per policy from ORDER_TIMEOUT_MS
 *   - reduceOnly is true for REDUCE/CLOSE/FLATTEN, false for OPEN/ADD
 */

import { CoinTierEnum, FlowTypeEnum, OrderIntentActionEnum, OrderPolicyEnum, PositionSideEnum, StrategyDirectionEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { DEFAULT_MAX_SLIPPAGE_OF_SL_PCT, MAX_SLIPPAGE_TIER_PCT, ORDER_TIMEOUT_MS } from '../../../src/execution/const';
import { OrderPolicyRouter, tierSlippageCapPct } from '../../../src/execution/service/OrderPolicyRouter';
import { buildPlanInput } from '../support/fixtures';
import { buildOrderIntent, buildProposedExit } from '../../risk/support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRouter(): OrderPolicyRouter {
    return new OrderPolicyRouter();
}

// ─── de-risking actions ───────────────────────────────────────────────────────

describe('OrderPolicyRouter — de-risking actions', () => {
    const deRiskingActions = [OrderIntentActionEnum.REDUCE, OrderIntentActionEnum.CLOSE, OrderIntentActionEnum.FLATTEN] as const;

    const tiers = [CoinTierEnum.TIER_1, CoinTierEnum.TIER_2, CoinTierEnum.TIER_3] as const;
    const flows = Object.values(FlowTypeEnum) as FlowTypeEnum[];

    for (const action of deRiskingActions) {
        it(`${action} always yields REDUCE_MARKET regardless of tier and flow`, () => {
            const router = makeRouter();

            for (const tier of tiers) {
                for (const flow of flows) {
                    // BUILD
                    const input = buildPlanInput({ intentAction: action, coinTier: tier, flowType: flow });

                    // OPERATE
                    const plan = router.plan(input);

                    // CHECK
                    expect(plan.policy).toBe(OrderPolicyEnum.REDUCE_MARKET);
                }
            }
        });
    }

    it('REDUCE_MARKET plan has reduceOnly=true', () => {
        const router = makeRouter();
        const input = buildPlanInput({ intentAction: OrderIntentActionEnum.CLOSE });
        const plan = router.plan(input);

        expect(plan.reduceOnly).toBe(true);
    });

    it('REDUCE_MARKET cancel timeout equals ORDER_TIMEOUT_MS for reduce_market policy', () => {
        const router = makeRouter();
        const input = buildPlanInput({ intentAction: OrderIntentActionEnum.CLOSE });
        const plan = router.plan(input);

        expect(plan.timeoutMs).toBe(ORDER_TIMEOUT_MS[OrderPolicyEnum.REDUCE_MARKET]);
    });
});

// ─── mean-reversion entry policy matrix ──────────────────────────────────────

describe('OrderPolicyRouter — mean-reversion entries', () => {
    it('OPEN mean-reversion tier-1 FORCED_EXHAUSTION → MARKETABLE_LIMIT_IOC', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        });

        expect(router.plan(input).policy).toBe(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
    });

    it('ADD mean-reversion tier-1 FORCED_EXHAUSTION → MARKETABLE_LIMIT_IOC', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.ADD,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        });

        expect(router.plan(input).policy).toBe(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
    });

    it('OPEN mean-reversion tier-2 FORCED_EXHAUSTION → POST_ONLY_MAKER (not IOC)', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_2,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        });

        expect(router.plan(input).policy).toBe(OrderPolicyEnum.POST_ONLY_MAKER);
    });

    it('OPEN mean-reversion tier-3 FORCED_EXHAUSTION → POST_ONLY_MAKER (not IOC)', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_3,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        });

        expect(router.plan(input).policy).toBe(OrderPolicyEnum.POST_ONLY_MAKER);
    });

    const nonForcedFlows = [FlowTypeEnum.TREND_INITIATION, FlowTypeEnum.CATALYST_RISK, FlowTypeEnum.MARKET_BETA, FlowTypeEnum.LOW_QUALITY_NOISE] as const;

    for (const flow of nonForcedFlows) {
        it(`OPEN mean-reversion tier-1 ${flow} → POST_ONLY_MAKER`, () => {
            const router = makeRouter();
            const input = buildPlanInput({
                intentAction: OrderIntentActionEnum.OPEN,
                strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
                coinTier: CoinTierEnum.TIER_1,
                flowType: flow,
            });

            expect(router.plan(input).policy).toBe(OrderPolicyEnum.POST_ONLY_MAKER);
        });
    }

    it('POST_ONLY_MAKER cancel timeout equals ORDER_TIMEOUT_MS for post_only_maker policy', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            flowType: FlowTypeEnum.TREND_INITIATION,
        });
        const plan = router.plan(input);

        expect(plan.timeoutMs).toBe(ORDER_TIMEOUT_MS[OrderPolicyEnum.POST_ONLY_MAKER]);
    });

    it('OPEN/ADD entry has reduceOnly=false', () => {
        const router = makeRouter();
        const input = buildPlanInput({ intentAction: OrderIntentActionEnum.OPEN });
        const plan = router.plan(input);

        expect(plan.reduceOnly).toBe(false);
    });
});

// ─── momentum entry policy matrix ────────────────────────────────────────────

describe('OrderPolicyRouter — momentum entries', () => {
    const tiers = [CoinTierEnum.TIER_1, CoinTierEnum.TIER_2, CoinTierEnum.TIER_3] as const;
    const flows = Object.values(FlowTypeEnum) as FlowTypeEnum[];

    for (const tier of tiers) {
        it(`momentum OPEN tier-${tier} any flow → MARKETABLE_LIMIT_IOC`, () => {
            const router = makeRouter();

            for (const flow of flows) {
                const input = buildPlanInput({
                    intentAction: OrderIntentActionEnum.OPEN,
                    strategyDirection: StrategyDirectionEnum.MOMENTUM,
                    coinTier: tier,
                    flowType: flow,
                });

                expect(router.plan(input).policy).toBe(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
            }
        });
    }

    it('MARKETABLE_LIMIT_IOC cancel timeout equals ORDER_TIMEOUT_MS for ioc policy', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MOMENTUM,
        });
        const plan = router.plan(input);

        expect(plan.timeoutMs).toBe(ORDER_TIMEOUT_MS[OrderPolicyEnum.MARKETABLE_LIMIT_IOC]);
    });
});

// ─── slippage cap math ────────────────────────────────────────────────────────

describe('OrderPolicyRouter — slippage cap computation', () => {
    it('slippage cap is min(tierCap, slDistance × maxSlOfSlPct)', () => {
        // BUILD: entryPrice=30000, stopLoss=30500 → stopDistance=500 → slDistancePct=1.667%
        // slBoundedCap = 1.667 × 25 / 100 = 0.4167%; tierCap tier-1 = 0.15%
        // effective cap = min(0.15, 0.4167) = 0.15
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        });

        const plan = router.plan(input);

        expect(plan.slippageCapPct.toFixed(2)).toBe(new Money(MAX_SLIPPAGE_TIER_PCT[CoinTierEnum.TIER_1]).toFixed(2));
    });

    it('slippage cap uses sl-bounded value when it is smaller than tier cap', () => {
        // BUILD: tight stop — stopLoss at 30050 so stopDistance=50 → slDistancePct=0.167%
        // slBoundedCap = 0.167 × 25 / 100 = 0.0417%; tier-1 cap = 0.15%
        // effective cap = min(0.15, 0.0417) = 0.0417
        const router = makeRouter();
        const intent = buildOrderIntent({
            coinTier: CoinTierEnum.TIER_1,
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.SHORT,
            entryPrice: new Money('30000'),
            proposedExit: buildProposedExit({
                stopLossPrice: new Money('30050'), // tight stop: only 50 from entry
                takeProfitPrice: new Money('29000'),
            }),
        });
        const input = {
            intent,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            maxSlippageOfSlPct: null,
        };

        const plan = router.plan(input);

        const stopDistance = new Money('50');
        const slDistancePct = stopDistance.dividedBy(new Money('30000')).times(100);
        const expectedSlBounded = slDistancePct.times(DEFAULT_MAX_SLIPPAGE_OF_SL_PCT).dividedBy(100);
        const tierCap = new Money(MAX_SLIPPAGE_TIER_PCT[CoinTierEnum.TIER_1]);
        const expectedCap = Money.min(tierCap, expectedSlBounded);

        expect(plan.slippageCapPct.toFixed(6)).toBe(expectedCap.toFixed(6));
        expect(plan.slippageCapPct.lessThan(tierCap)).toBe(true);
    });

    it('IOC limit price for SHORT is entry × (1 - slippageCapPct/100)', () => {
        // SHORT taker crosses the BID: price must be below entry
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MOMENTUM,
            coinTier: CoinTierEnum.TIER_1,
            tradeSide: PositionSideEnum.SHORT,
            flowType: FlowTypeEnum.TREND_INITIATION,
        });

        const plan = router.plan(input);
        const cap = plan.slippageCapPct.dividedBy(100);
        const expectedPrice = new Money('30000').times(new Money(1).minus(cap));

        expect(plan.limitPrice.toFixed(6)).toBe(expectedPrice.toFixed(6));
    });

    it('IOC limit price for LONG is entry × (1 + slippageCapPct/100)', () => {
        // LONG taker crosses the ASK: price must be above entry
        const router = makeRouter();
        const intent = buildOrderIntent({
            coinTier: CoinTierEnum.TIER_1,
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.LONG,
            entryPrice: new Money('30000'),
            proposedExit: buildProposedExit({
                stopLossPrice: new Money('29500'), // below entry for LONG
                takeProfitPrice: new Money('31000'),
            }),
        });
        const input = {
            intent,
            strategyDirection: StrategyDirectionEnum.MOMENTUM,
            flowType: FlowTypeEnum.TREND_INITIATION,
            maxSlippageOfSlPct: null,
        };

        const plan = router.plan(input);
        const cap = plan.slippageCapPct.dividedBy(100);
        const expectedPrice = new Money('30000').times(new Money(1).plus(cap));

        expect(plan.limitPrice.toFixed(6)).toBe(expectedPrice.toFixed(6));
    });

    it('POST_ONLY_MAKER limit price equals entry reference price', () => {
        const router = makeRouter();
        const input = buildPlanInput({
            intentAction: OrderIntentActionEnum.OPEN,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.TREND_INITIATION,
        });

        const plan = router.plan(input);

        expect(plan.limitPrice.toFixed()).toBe(new Money('30000').toFixed());
    });

    it('tierSlippageCapPct helper returns the correct cap for each tier', () => {
        expect(tierSlippageCapPct(CoinTierEnum.TIER_1).toNumber()).toBe(MAX_SLIPPAGE_TIER_PCT[CoinTierEnum.TIER_1]);
        expect(tierSlippageCapPct(CoinTierEnum.TIER_2).toNumber()).toBe(MAX_SLIPPAGE_TIER_PCT[CoinTierEnum.TIER_2]);
        expect(tierSlippageCapPct(CoinTierEnum.TIER_3).toNumber()).toBe(MAX_SLIPPAGE_TIER_PCT[CoinTierEnum.TIER_3]);
    });
});

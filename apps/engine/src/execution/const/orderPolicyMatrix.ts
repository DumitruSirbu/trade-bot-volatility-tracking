import { CoinTierEnum, FlowTypeEnum, OrderIntentActionEnum, OrderPolicyEnum, StrategyDirectionEnum } from '@bot/shared';

// The locked order-policy selection matrix (ADR 0005 §1). PURE table: a row is selected by
// (intentAction, strategyDirection, coinTier, flowType) and no other inputs — no wall clock,
// no random branch, so M7 replays the same matrix and produces the same policy choice.
//
// Reduce/close/flatten always REDUCE_MARKET (row 7) regardless of direction/tier/flow — a
// de-risking that fails to fill is worse than any slippage (ADR 0005 row 7 rationale).
//
// Mean-reversion in a liquidation cascade is the ONE place we cross the book on entry (the
// edge is "be the maker faded into a forced seller"; resting post-only loses the fill). Every
// other mean-reversion entry posts maker. Momentum always takes liquidity by definition.
//
// IMPORTANT: live AND backtest import this module — the single source of truth (ADR 0005 §5
// / live-vs-backtest contract C5). A diff in either direction is a must-fix.

// Lookup key. Ordered fields for deterministic serialization in audit/M7-pin tests.
export interface IOrderPolicyMatrixKey {
    readonly intentAction: OrderIntentActionEnum;
    readonly strategyDirection: StrategyDirectionEnum;
    readonly coinTier: CoinTierEnum;
    readonly flowType: FlowTypeEnum;
}

// One matrix row.
interface IOrderPolicyMatrixRow extends IOrderPolicyMatrixKey {
    readonly policy: OrderPolicyEnum;
}

// De-risking rows are independent of direction/tier/flow — collapsed into a single set
// at the lookup helper rather than spelled out 24 times.
const DE_RISKING_ACTIONS: ReadonlySet<OrderIntentActionEnum> = new Set([
    OrderIntentActionEnum.REDUCE,
    OrderIntentActionEnum.CLOSE,
    OrderIntentActionEnum.FLATTEN,
]);

// Flow-type semantics for the matrix (ADR 0005 §1 talks in terms of "liquidation_cascade" /
// "new_money / catalyst"; the shared FlowTypeEnum encodes them as FORCED_EXHAUSTION /
// TREND_INITIATION / CATALYST_RISK / MARKET_BETA / LOW_QUALITY_NOISE — see
// packages/shared/src/util/classifyFlowType.ts).
//
//   FORCED_EXHAUSTION  ≡ liquidation cascade (mean-reversion takes liquidity here)
//   TREND_INITIATION   ≡ new-money / catalyst leg (momentum takes liquidity here)
//   CATALYST_RISK      ≡ news-driven move (momentum takes liquidity here)
//   MARKET_BETA        ≡ macro/beta drift (no special-case)
//   LOW_QUALITY_NOISE  ≡ noise (no special-case)

// Entry rows — every OPEN/ADD permutation that the executor can encounter. Mean-reversion in
// FORCED_EXHAUSTION takes liquidity (IOC); every other mean-reversion entry posts maker.
// Momentum always takes liquidity by definition (any tier, any flow).
const ENTRY_ROWS: ReadonlyArray<IOrderPolicyMatrixRow> = [
    // Mean-reversion in a forced-exhaustion (liquidation cascade): IOC across the book.
    {
        intentAction: OrderIntentActionEnum.OPEN,
        strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
        coinTier: CoinTierEnum.TIER_1,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
    },
    {
        intentAction: OrderIntentActionEnum.ADD,
        strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
        coinTier: CoinTierEnum.TIER_1,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
    },
    // Mean-reversion in any other flow context: maker (early/contrarian; afford to wait).
    ...buildMeanReversionMakerRows(),
    // Momentum: always IOC. Tier-2/3 takes the same IOC with a tighter effective cap.
    ...buildMomentumIocRows(),
];

// Mean-reversion maker rows for every (tier, flow ≠ FORCED_EXHAUSTION) combination.
function buildMeanReversionMakerRows(): IOrderPolicyMatrixRow[] {
    const tiers: CoinTierEnum[] = [CoinTierEnum.TIER_1, CoinTierEnum.TIER_2, CoinTierEnum.TIER_3];
    const flows: FlowTypeEnum[] = [FlowTypeEnum.TREND_INITIATION, FlowTypeEnum.CATALYST_RISK, FlowTypeEnum.MARKET_BETA, FlowTypeEnum.LOW_QUALITY_NOISE];
    const actions: OrderIntentActionEnum[] = [OrderIntentActionEnum.OPEN, OrderIntentActionEnum.ADD];
    const rows: IOrderPolicyMatrixRow[] = [];

    for (const action of actions) {
        for (const tier of tiers) {
            for (const flow of flows) {
                rows.push({
                    intentAction: action,
                    strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
                    coinTier: tier,
                    flowType: flow,
                    policy: OrderPolicyEnum.POST_ONLY_MAKER,
                });
            }
        }
    }

    // Tier-2/3 mean-reversion in a cascade is also maker (only tier-1 cascade is IOC per the
    // ADR — tier-2/3 cascades are less reliable, prefer maker fade).
    for (const action of actions) {
        for (const tier of [CoinTierEnum.TIER_2, CoinTierEnum.TIER_3]) {
            rows.push({
                intentAction: action,
                strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
                coinTier: tier,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                policy: OrderPolicyEnum.POST_ONLY_MAKER,
            });
        }
    }

    return rows;
}

// Momentum IOC rows for every (tier, flow). Momentum is always taker by definition; if the
// router/strategy decided MOMENTUM, the flow has already been filtered upstream.
function buildMomentumIocRows(): IOrderPolicyMatrixRow[] {
    const tiers: CoinTierEnum[] = [CoinTierEnum.TIER_1, CoinTierEnum.TIER_2, CoinTierEnum.TIER_3];
    const flows: FlowTypeEnum[] = [
        FlowTypeEnum.TREND_INITIATION,
        FlowTypeEnum.CATALYST_RISK,
        FlowTypeEnum.FORCED_EXHAUSTION,
        FlowTypeEnum.MARKET_BETA,
        FlowTypeEnum.LOW_QUALITY_NOISE,
    ];
    const actions: OrderIntentActionEnum[] = [OrderIntentActionEnum.OPEN, OrderIntentActionEnum.ADD];
    const rows: IOrderPolicyMatrixRow[] = [];

    for (const action of actions) {
        for (const tier of tiers) {
            for (const flow of flows) {
                rows.push({
                    intentAction: action,
                    strategyDirection: StrategyDirectionEnum.MOMENTUM,
                    coinTier: tier,
                    flowType: flow,
                    policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                });
            }
        }
    }

    return rows;
}

// Default for any uncatalogued (entry-row) combination. Defensively maker: under-fill is a
// missed trade (skip-first culture), over-take silently degrades the edge. Explicit listing
// above means this default fires only when a new flow_type / tier is added and the matrix
// has not been updated — surfaced via the WARN log in lookupOrderPolicy.
const ENTRY_FALLBACK_POLICY: OrderPolicyEnum = OrderPolicyEnum.POST_ONLY_MAKER;

// Hybrid (v3) directly inherits the underlying leg's row at lookup time — the orchestrator
// resolves the router leg before calling here, so the strategyDirection passed in is already
// the resolved leg (MEAN_REVERSION or MOMENTUM). No HYBRID row is needed in the matrix.

// Pure lookup. Returns the matching row's policy, or the entry fallback (with the caller
// expected to log a warning) if no exact row exists. De-risking actions short-circuit.
export function lookupOrderPolicy(key: IOrderPolicyMatrixKey): OrderPolicyEnum {
    if (DE_RISKING_ACTIONS.has(key.intentAction)) {
        return OrderPolicyEnum.REDUCE_MARKET;
    }

    const match = ENTRY_ROWS.find(
        (row) =>
            row.intentAction === key.intentAction &&
            row.strategyDirection === key.strategyDirection &&
            row.coinTier === key.coinTier &&
            row.flowType === key.flowType,
    );

    if (match !== undefined) {
        return match.policy;
    }

    return ENTRY_FALLBACK_POLICY;
}

// Whether a key matches an explicit catalogued row. Callers (router) check this to decide
// whether to log a WARN ("uncatalogued combination, using fallback") vs DEBUG. Pure.
export function isCatalogued(key: IOrderPolicyMatrixKey): boolean {
    if (DE_RISKING_ACTIONS.has(key.intentAction)) {
        return true;
    }

    return ENTRY_ROWS.some(
        (row) =>
            row.intentAction === key.intentAction &&
            row.strategyDirection === key.strategyDirection &&
            row.coinTier === key.coinTier &&
            row.flowType === key.flowType,
    );
}

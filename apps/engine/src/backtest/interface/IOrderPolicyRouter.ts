import { IOrderPlanInput } from '../../execution/service/OrderPolicyRouter';
import { IOrderPlanInternal } from '../../execution/interface';

// Engine-internal seam (M8 W1). The live `OrderPolicyRouter` (apps/engine/src/execution/
// service/OrderPolicyRouter.ts) structurally implements this interface: the backtest
// orchestrator depends on it instead of the concrete class so tests can substitute a fake
// (single-policy or assertion-driven) without dragging execution-module wiring into the
// replay container.
//
// Why this lives in `backtest/interface/` and NOT `@bot/shared`:
//   - Only the engine consumes it (the dashboard never instantiates a router).
//   - It carries `MoneyValue`-rich types from `IOrderPlanInternal`, which are engine-local.
//   - Promoting it to `@bot/shared` would force a serialization boundary for purely
//     in-process routing — not worth the surface area.
//
// The live router remains the default at module wiring time so backtest routing matches
// live byte-for-byte; the interface exists for substitution, not for re-implementation.
export interface IOrderPolicyRouter {
    plan(input: IOrderPlanInput): IOrderPlanInternal;
}

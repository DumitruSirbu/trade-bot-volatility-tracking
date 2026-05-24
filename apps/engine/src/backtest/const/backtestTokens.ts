// DI tokens for BacktestModule (M8 W1).
//
// BACKTEST_ORDER_POLICY_ROUTER — injection point for the order-policy router. Default
// binding is the live `OrderPolicyRouter` so backtest routing matches live byte-for-byte;
// integration tests can override the provider with a fake to isolate single-policy paths
// or to assert call args (e.g. proving `flow_type` reaches the router).
export const BACKTEST_ORDER_POLICY_ROUTER = Symbol('BACKTEST_ORDER_POLICY_ROUTER');

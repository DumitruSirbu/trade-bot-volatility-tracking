import { MoneyValue } from '../../common/utils/money';

// Operator risk limits, resolved by the orchestrator from AppConfigService (live) or seeded
// from riskConsts (backtest). Threaded through IRiskGateContext so the gate reads the real
// control surface, not hardcoded defaults (ADR 0004 Conflicts #1; the env values must not be
// a no-op).
export interface IRiskLimits {
    readonly dailyLossLimitUsdt: MoneyValue;
    readonly weeklyLossLimitUsdt: MoneyValue;
    readonly maxExposurePerCoinUsdt: MoneyValue;
    readonly maxSameDirectionExposureUsdt: MoneyValue;
    readonly cooldownAfterLossMs: number;
}

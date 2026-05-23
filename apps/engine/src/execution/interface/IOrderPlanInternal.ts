import { OrderPolicyEnum } from '@bot/shared';

import { DecimalValue, MoneyValue } from '../../common/utils/money';

// The engine-internal counterpart to the shared `IOrderPlan` (orderPlanSchema). The shared
// type carries decimal-as-string for serialization parity with M7; the engine carries
// MoneyValue / DecimalValue so the executor can do further decimal math without re-parsing.
// Mapped to the shared shape at the persistence/wire boundary.
export interface IOrderPlanInternal {
    readonly policy: OrderPolicyEnum;
    readonly limitPrice: MoneyValue; // ignored for REDUCE_MARKET
    readonly timeoutMs: number;
    readonly slippageCapPct: DecimalValue;
    readonly reduceOnly: boolean;
}

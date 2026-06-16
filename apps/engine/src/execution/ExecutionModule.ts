import { Module, forwardRef } from '@nestjs/common';

import { CommonModule } from '../common/CommonModule';
import { AppConfigModule } from '../config/AppConfigModule';
import { ExchangeModule } from '../exchange/ExchangeModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { StrategyModule } from '../strategy/StrategyModule';
import {
    ClientOrderIdFactory,
    ExchangeOrderSubmitter,
    ExecutionService,
    FillAcceptanceUnwindService,
    FillAccumulator,
    LocalProtectiveMonitor,
    OrderPolicyRouter,
    PositionTimeStopEnforcer,
    ProtectiveOrderAttacher,
    SharedCloseCoordinator,
} from './service';

// M5 ExecutionModule. The single legitimate caller of the exchange order API: subscribes to
// `order.intent.approved` events from M4 and routes them through the policy router → submitter
// → fill accumulator → position/transactions writers → protective attacher (ADR 0005–0008).
//
// CommonModule is imported for HaltFlagService (kill-switch gate, must-fix #6).
//
// No other module / service / controller may construct or use the ExchangeOrderSubmitter,
// the OrderPolicyRouter, or call ccxt's createOrder/cancelOrder/fetchOrder. Reviewer must-fix
// invariant from ADR 0005/0006: a single chokepoint preserves idempotency + risk-gate routing.
@Module({
    imports: [AppConfigModule, CommonModule, ExchangeModule, forwardRef(() => PositionModule), forwardRef(() => RiskModule), StrategyModule],
    providers: [
        ClientOrderIdFactory,
        ExchangeOrderSubmitter,
        FillAcceptanceUnwindService,
        FillAccumulator,
        LocalProtectiveMonitor,
        OrderPolicyRouter,
        PositionTimeStopEnforcer,
        ProtectiveOrderAttacher,
        SharedCloseCoordinator,
        ExecutionService,
    ],
    // M33 Fix 1b — export SharedCloseCoordinator so PositionModule's ReconciliationService
    // injects the SAME single instance (the registry must not be duplicated; two instances
    // = two registries = the double-close it exists to prevent). PositionModule already
    // imports ExecutionModule (via forwardRef) and consumes LocalProtectiveMonitor the same way.
    exports: [ExecutionService, LocalProtectiveMonitor, SharedCloseCoordinator],
})
export class ExecutionModule {}

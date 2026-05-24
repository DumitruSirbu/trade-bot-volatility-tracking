import { Module } from '@nestjs/common';

import { ExecutionModule } from '../execution/ExecutionModule';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { EngineBootstrapService } from './service';

// Composition-root module for `EngineBootstrapService` (ADR 0014). The service
// orchestrates the ten-phase boot pipeline across PositionModule (state +
// PositionInstrumentor + AccountSnapshotWriter + ReconciliationService),
// ExecutionModule (LocalProtectiveMonitor re-arm), RiskModule (gate
// recovery-ready flip + open_exposure rebuild), and MarketDataModule
// (SubscriptionRetainer rebuild).
//
// Lifting the service out of `position/service/` lets it sit structurally ABOVE
// all three peers — there is no inbound consumer of BootstrapModule, so it
// cannot re-enter a cycle. That removes the three `forwardRef` injections
// (ReconciliationService, LocalProtectiveMonitor, RiskGateService) the service
// previously needed when it lived under PositionModule.
//
// No exports: the service self-runs through `OnApplicationBootstrap`. Tests
// construct it positionally from `src/bootstrap/service/EngineBootstrapService.ts`.
@Module({
    imports: [PositionModule, ExecutionModule, RiskModule, MarketDataModule],
    providers: [EngineBootstrapService],
})
export class BootstrapModule {}

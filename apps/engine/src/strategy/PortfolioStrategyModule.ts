import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { CLOCK_PORT } from './interface/IClockPort';
import { MomentumOrchestratorService } from './service/MomentumOrchestratorService';
import { RebalanceSchedulerService } from './service/RebalanceSchedulerService';
import { StrategyModule } from './StrategyModule';
import { XMomPortfolioStrategy } from './strategies/XMomPortfolioStrategy';

// M50 (ADR 0047 / ADR 0048) — the cross-sectional momentum portfolio path: the pure ranking
// strategy, the interval scheduler, and the rebalance orchestrator. Deliberately separate from
// StrategyModule (the VWAP per-symbol path) so the OCP boundary is physical — no v0–v3 file or
// StrategyService is touched. Plain imports (no forwardRef): nothing imports this module, so it is
// a pure leaf. StrategyModule is imported for its exported StrategyVersionRepository +
// DecisionRepository; MarketDataModule / RiskModule / PositionModule supply the universe, gate,
// sizer, adapters, and position reads. CLOCK_PORT wraps Date.now() in production (faked in tests).
@Module({
    imports: [MarketDataModule, RiskModule, PositionModule, StrategyModule],
    providers: [
        XMomPortfolioStrategy,
        RebalanceSchedulerService,
        MomentumOrchestratorService,
        { provide: CLOCK_PORT, useValue: { nowMs: (): number => Date.now() } },
    ],
})
export class PortfolioStrategyModule {}

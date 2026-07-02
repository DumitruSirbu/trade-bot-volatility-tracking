import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from '../auth/AuthModule';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { REBALANCE_TRIGGER_RATE_LIMIT, REBALANCE_TRIGGER_RATE_TTL_MS } from './const';
import { RebalanceDevController } from './controller';
import { CLOCK_PORT } from './interface/IClockPort';
import { MomentumOrchestratorService } from './service/MomentumOrchestratorService';
import { RebalanceSchedulerService } from './service/RebalanceSchedulerService';
import { StrategyModule } from './StrategyModule';
import { XMomPortfolioStrategy } from './strategies/XMomPortfolioStrategy';

// The manual rebalance trigger is a paper-only dev/ops seam (ADR 0048 §10). The service enforces
// paper-only via a domain exception, but we ALSO gate registration so the admin route does not
// exist at all outside paper env. Read from process.env at module-load time (AppConfigService is
// not yet resolvable during static @Module evaluation) — the same env var the service reads.
const isPaperEnv = process.env.EXCHANGE_ENV === ExchangeEnvironmentEnum.PAPER;
const paperOnlyControllers = isPaperEnv ? [RebalanceDevController] : [];

// M50 (ADR 0047 / ADR 0048) — the cross-sectional momentum portfolio path: the pure ranking
// strategy, the interval scheduler, and the rebalance orchestrator. Deliberately separate from
// StrategyModule (the VWAP per-symbol path) so the OCP boundary is physical — no v0–v3 file or
// StrategyService is touched. Plain imports (no forwardRef): nothing imports this module, so it is
// a pure leaf. StrategyModule is imported for its exported StrategyVersionRepository +
// DecisionRepository; MarketDataModule / RiskModule / PositionModule supply the universe, gate,
// sizer, adapters, and position reads. CLOCK_PORT wraps Date.now() in production (faked in tests).
@Module({
    imports: [
        AuthModule,
        MarketDataModule,
        RiskModule,
        PositionModule,
        StrategyModule,
        // Defense-in-depth rate limit for the paper-only admin trigger endpoint (security review).
        // Supplies ThrottlerGuard's options/storage; the guard is applied per-route on the controller.
        ThrottlerModule.forRoot([{ ttl: REBALANCE_TRIGGER_RATE_TTL_MS, limit: REBALANCE_TRIGGER_RATE_LIMIT }]),
    ],
    controllers: paperOnlyControllers,
    providers: [
        XMomPortfolioStrategy,
        RebalanceSchedulerService,
        MomentumOrchestratorService,
        { provide: CLOCK_PORT, useValue: { nowMs: (): number => Date.now() } },
    ],
})
export class PortfolioStrategyModule {}

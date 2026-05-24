import { Module } from '@nestjs/common';

import { StrategyModule } from '../strategy/StrategyModule';
import { PromotionGateService, PromotionService } from './service';

// M8 W6 — promotion gate + state-machine mechanism (ADR 0019 + ADR 0016 §2.2).
//
// Depends on StrategyModule for StrategyVersionRepository and
// ComparisonReportRepository (re-exported there). DataSource is injected via
// @InjectDataSource for the serializable promotion transaction; no TypeOrm
// forFeature() import is needed because the entities live with StrategyModule.
//
// W6 does NOT import BacktestModule. Robustness criteria 7 & 9 are deferred to
// W6.1 — when they land they will need BacktestRunnerService and this module
// will import BacktestModule then.
@Module({
    imports: [StrategyModule],
    providers: [PromotionGateService, PromotionService],
    exports: [PromotionGateService, PromotionService],
})
export class PromotionModule {}

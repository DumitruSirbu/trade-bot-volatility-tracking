import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DecisionEntity, StrategyVersionEntity } from './entity';
import { DecisionRepository } from './repository/DecisionRepository';
import { StrategyVersionRepository } from './repository/StrategyVersionRepository';

// M2 shell: owns strategy_versions + decisions (entities + repositories) only. The
// strategy engine (services/registry/decision writer) lands in M3 — this module grows,
// the entities never move (ADR 0002 §1).
@Module({
    imports: [TypeOrmModule.forFeature([StrategyVersionEntity, DecisionEntity])],
    providers: [StrategyVersionRepository, DecisionRepository],
    exports: [StrategyVersionRepository, DecisionRepository],
})
export class StrategyModule {}

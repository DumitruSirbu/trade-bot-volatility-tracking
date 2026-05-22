import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RiskStateEntity } from './entity';
import { RiskStateRepository } from './repository/RiskStateRepository';

// M2 shell: owns risk_state (entity + repository) only. The risk gate (sizing, limits,
// stress halt, kill switch) lands in M4 (ADR 0002 §1).
@Module({
    imports: [TypeOrmModule.forFeature([RiskStateEntity])],
    providers: [RiskStateRepository],
    exports: [RiskStateRepository],
})
export class RiskModule {}

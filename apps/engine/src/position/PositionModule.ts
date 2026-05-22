import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountSnapshotEntity, PositionEntity, TransactionEntity } from './entity';
import { AccountSnapshotRepository } from './repository/AccountSnapshotRepository';
import { PositionRepository } from './repository/PositionRepository';
import { TransactionRepository } from './repository/TransactionRepository';

// M2 shell: owns positions + transactions + account_snapshots (entities + repositories)
// only. Position management/reconciliation services land in M5–M6 (ADR 0002 §1).
@Module({
    imports: [TypeOrmModule.forFeature([PositionEntity, TransactionEntity, AccountSnapshotEntity])],
    providers: [PositionRepository, TransactionRepository, AccountSnapshotRepository],
    exports: [PositionRepository, TransactionRepository, AccountSnapshotRepository],
})
export class PositionModule {}

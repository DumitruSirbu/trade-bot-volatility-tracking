import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/CommonModule';
import { ExchangeModule } from '../exchange/ExchangeModule';
import { ExecutionModule } from '../execution/ExecutionModule';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { RiskModule } from '../risk/RiskModule';
import { StrategyVersionEntity } from '../strategy/entity';
import { StrategyVersionRepository } from '../strategy/repository/StrategyVersionRepository';
import { AccountSnapshotEntity, PositionEntity, TransactionEntity } from './entity';
import { AccountSnapshotRepository } from './repository/AccountSnapshotRepository';
import { PositionRepository } from './repository/PositionRepository';
import { TransactionRepository } from './repository/TransactionRepository';
import {
    AccountSnapshotWriter,
    EngineBootstrapService,
    PositionInstrumentor,
    PositionLifecycleRetentionListener,
    PositionService,
    ReconciliationService,
} from './service';

// Owns positions + transactions + account_snapshots entities and repositories,
// plus the M6 PositionService — the single write API for the position state
// machine (ADR 0009). PositionLifecycleRetentionListener (W2) bridges state
// transitions to MarketDataModule's SubscriptionRetainer per ADR 0011 §5. The
// M6 W4a `ReconciliationService` lives alongside (it depends on the same
// repositories + the gate + the W3 monitor). Risk and Execution are imported
// via `forwardRef` because both modules import PositionModule for repositories —
// the cycle is real but pure at construction time, NestJS resolves it via
// `forwardRef` and the consuming service uses `@Inject(forwardRef(...))` for
// the gate / monitor injections.
//
// StrategyVersionRepository is registered locally rather than by importing
// StrategyModule — StrategyModule itself imports PositionModule, so importing
// it here would create a tighter cycle than the read-only need justifies. The
// repository is a thin wrapper over the TypeORM repository; binding it twice
// is safe because TypeORM's DI scope keys on the entity, not the wrapper.
@Module({
    imports: [
        TypeOrmModule.forFeature([PositionEntity, TransactionEntity, AccountSnapshotEntity, StrategyVersionEntity]),
        CommonModule,
        MarketDataModule,
        ExchangeModule,
        forwardRef(() => RiskModule),
        forwardRef(() => ExecutionModule),
    ],
    providers: [
        PositionRepository,
        TransactionRepository,
        AccountSnapshotRepository,
        StrategyVersionRepository,
        PositionService,
        PositionLifecycleRetentionListener,
        ReconciliationService,
        PositionInstrumentor,
        AccountSnapshotWriter,
        EngineBootstrapService,
    ],
    exports: [
        PositionRepository,
        TransactionRepository,
        AccountSnapshotRepository,
        PositionService,
        ReconciliationService,
        PositionInstrumentor,
        AccountSnapshotWriter,
        EngineBootstrapService,
    ],
})
export class PositionModule {}

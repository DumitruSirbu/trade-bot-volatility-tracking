import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskStateEntity } from './entity';
import { RiskStateRepository } from './repository/RiskStateRepository';
import {
    InstrumentPortAdapter,
    OpenPositionsPortAdapter,
    PositionSizer,
    ReservationLedger,
    RiskGateService,
    RiskStatePortAdapter,
    SlotManager,
    StressHaltEvaluator,
} from './service';

// The central risk gate (ADR 0004). Owns risk_state plus the gate, sizer, slot manager,
// stress evaluator, the in-memory reservation ledger, and the live state-port adapters
// (PositionModule → PositionRepository, MarketDataModule → InstrumentRepository). Exports the
// gate + sizer + ledger + adapters so the StrategyService orchestrator (StrategyModule) can
// assemble IOrderIntent and call the gate synchronously after evaluate (§1).
@Module({
    imports: [TypeOrmModule.forFeature([RiskStateEntity]), PositionModule, MarketDataModule],
    providers: [
        RiskStateRepository,
        PositionSizer,
        SlotManager,
        StressHaltEvaluator,
        ReservationLedger,
        RiskGateService,
        RiskStatePortAdapter,
        OpenPositionsPortAdapter,
        InstrumentPortAdapter,
    ],
    exports: [RiskStateRepository, PositionSizer, RiskGateService, ReservationLedger, RiskStatePortAdapter, OpenPositionsPortAdapter, InstrumentPortAdapter],
})
export class RiskModule {}

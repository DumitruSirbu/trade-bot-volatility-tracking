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
// (PositionModule → PositionRepository via POSITION_QUERY, MarketDataModule →
// InstrumentRepository). Exports the gate + sizer + ledger + adapters so the StrategyService
// orchestrator (StrategyModule) can assemble IOrderIntent and call the gate synchronously
// after evaluate (§1).
//
// PositionModule is imported plainly (no `forwardRef`). The gate's *consumption* now flows
// through the `POSITION_QUERY` token instead of `@Inject(forwardRef(() => PositionRepository))`,
// killing the forwardRef on the gate's constructor side and shrinking the surface to a
// minimal read-only port. PositionModule still keeps `forwardRef(() => RiskModule)` because
// its W4a/W5/W6/W8 services inject RiskGateService synchronously (boot-complete signal,
// equity updates, case-(b)/case-(c) reconciliation primitives) — that asymmetry is enough
// for NestJS to break the cycle from one side. Collapsing the other end requires moving
// those position-side services off RiskGate, which is intentionally out of scope per the
// dispatch spec ("synchronous semantics" note).
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

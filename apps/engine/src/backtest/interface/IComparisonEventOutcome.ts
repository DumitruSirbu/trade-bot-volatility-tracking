import { ExitReasonEnum, FlowTypeEnum, RegimeLabelEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// What a single candidate version did with one event (ADR 0017 §2.3). Keys onto the tape
// entry's `eventId`; every candidate version supplies one of these records and the W4
// aggregator stuffs them into `IComparisonEventOutcome.outcomesByVersion`.
//
// Action contract:
//   - 'open'   → the strategy returned OPEN, the gate approved, the simulator filled.
//                `netPnl`, `holdMs`, `rPerUnitRisk`, `exitReason` are populated.
//   - 'skip'   → either the strategy returned SKIP, the gate rejected, or the open
//                position branch suppressed the entry (ADR 0017 §2.2: a skip is still a
//                meaningful comparison data point — peers may have opened on the same id).
//   - 'missed' → the gate approved but the simulator's limit cancel timer elapsed before
//                the limit price was touched (mirrors live MARKETABLE_LIMIT_IOC outcomes).
//
// `rPerUnitRisk` is the unit of analysis for the W5 bootstrap (ADR 0018). For 'skip' and
// 'missed' it is 0 by convention. The ratio is computed upstream from decimal arithmetic
// (`netPnl / riskBudgetSpent`) and is the ONE boundary `number` ADR 0017 §2.3 allows;
// every other money field on this shape stays `MoneyValue`.
export interface IPerVersionOutcomeRecord {
    readonly action: 'open' | 'skip' | 'missed';
    readonly netPnl?: MoneyValue;
    readonly holdMs?: number;
    readonly rPerUnitRisk?: number;
    readonly exitReason?: ExitReasonEnum;
    readonly lowFidelity?: boolean;
}

// One row per `event_id` across all candidate versions in a comparison run (ADR 0017 §2.3).
// `outcomesByVersion` is keyed by `strategy_versions.id` (number, per the entity PK).
//
// `regime` and `flowType` are denormalized from the tape entry so downstream regime
// breakdown logic (W5) does not need to re-zip outcomes against the tape.
export interface IComparisonEventOutcome {
    readonly eventId: string;
    readonly symbol: string;
    readonly triggerTs: number;
    readonly regime: RegimeLabelEnum;
    readonly flowType: FlowTypeEnum;
    readonly outcomesByVersion: Map<number, IPerVersionOutcomeRecord>;
}

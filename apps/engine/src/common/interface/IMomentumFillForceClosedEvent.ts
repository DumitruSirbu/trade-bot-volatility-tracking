import { DecimalValue } from '../utils/money';

// Payload for MOMENTUM_FILL_FORCE_CLOSED_EVENT (M52 D1, ADR 0051 §2.1). Emitted by
// ExecutionService.unwindRejectedFill when the ADR 0045 fill-acceptance guard force-closes an
// OPEN momentum position. The execution layer only REPORTS the force_close plus the drift it
// already measured in logGeometryAnchorDrift — it makes no retry decision. The momentum
// orchestrator consumes this to run the retry-eligibility breaker (§3).
//
// `rebalanceCycleId` and `rank` originate on the momentum OPEN intent the orchestrator stamped,
// so the event is self-describing. `atrUnitsDrift`/`driftPct` are DecimalValue ratios (not money)
// — the exact values logGeometryAnchorDrift computes; the orchestrator's volatility breaker keys
// on `atrUnitsDrift`.
export interface IMomentumFillForceClosedEvent {
    readonly rebalanceCycleId: string;
    readonly symbol: string;
    readonly strategyVersionId: number;
    readonly rank: number;
    readonly atrUnitsDrift: DecimalValue;
    readonly driftPct: DecimalValue;
    readonly reason: string | undefined;
}

import { FlowTypeEnum, PositionSideEnum, SignalActionEnum, SignalTypeEnum, SkipReasonEnum } from '@bot/shared';

import { IProposedExit } from './IProposedExit';

// The strategy↔orchestrator contract (ADR 0003 §2). Engine-internal because it carries
// MoneyValue; the dashboard reads the persisted decisions row, not this in-memory signal.
// evaluate ALWAYS returns an ISignal — a no-trade outcome is action=SKIP with a populated
// skipReason. There is no nullable / "no signal" path.
export interface ISignal {
    readonly action: SignalActionEnum;
    readonly signalType: SignalTypeEnum;
    readonly skipReason: SkipReasonEnum | null; // non-null IFF action === SKIP
    readonly tradeSide: PositionSideEnum | null; // long|short, decided by the strategy; null on skip
    readonly signalScore: number; // 0–100, stamped on every decision incl. skip
    readonly flowType: FlowTypeEnum; // classified value carried through (stamped by orchestrator)
    readonly reason: string; // machine-readable code (mirrors skipReason or an entry-thesis code)
    readonly proposedExit: IProposedExit | null; // null on skip
}

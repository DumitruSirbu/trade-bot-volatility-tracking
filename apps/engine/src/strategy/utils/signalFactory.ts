import { FlowTypeEnum, PositionSideEnum, SignalActionEnum, SignalTypeEnum, SkipReasonEnum } from '@bot/shared';

import { ISignal } from '../interface/ISignal';
import { IProposedExit } from '../interface/IProposedExit';

// Pure signal constructors shared by v1/v2/v3 so the ISignal shape is assembled in one
// place (DRY across the three trading versions). No I/O, no clock — callers pass every
// value in.

export function buildSkipSignal(args: { signalType: SignalTypeEnum; skipReason: SkipReasonEnum; signalScore: number; flowType: FlowTypeEnum }): ISignal {
    return {
        action: SignalActionEnum.SKIP,
        signalType: args.signalType,
        skipReason: args.skipReason,
        tradeSide: null,
        signalScore: args.signalScore,
        flowType: args.flowType,
        reason: args.skipReason,
        proposedExit: null,
    };
}

export function buildOpenSignal(args: {
    signalType: SignalTypeEnum;
    tradeSide: PositionSideEnum;
    signalScore: number;
    flowType: FlowTypeEnum;
    reason: string;
    proposedExit: IProposedExit;
}): ISignal {
    return {
        action: SignalActionEnum.OPEN,
        signalType: args.signalType,
        skipReason: null,
        tradeSide: args.tradeSide,
        signalScore: args.signalScore,
        flowType: args.flowType,
        reason: args.reason,
        proposedExit: args.proposedExit,
    };
}

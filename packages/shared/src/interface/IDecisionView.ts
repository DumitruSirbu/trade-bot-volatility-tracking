import { SignalActionEnum } from '../enum/SignalActionEnum.js';
import { FlowTypeEnum } from '../enum/FlowTypeEnum.js';

export interface IDecisionView {
    id: string;
    occurredAt: string;
    symbol: string;
    action: SignalActionEnum;
    flowType: FlowTypeEnum;
    signalScore: string | null;
    reason: string | null;
    strategyVersionId: string;
    eventId: string;
    positionId?: string | null;
}

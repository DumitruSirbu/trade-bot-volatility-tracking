import { HaltAuditActionEnum } from '../enum/HaltAuditActionEnum.js';

export interface IHaltAuditEntry {
    id: string;
    occurredAt: string;
    actorSub: string;
    actorJti: string;
    sourceIp: string | null;
    action: HaltAuditActionEnum;
    reason: string;
    flattenRequested: boolean;
    previousState: 'running' | 'halted';
    newState: 'running' | 'halted';
    correlationEventId: string | null;
}

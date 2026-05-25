export interface IHaltAuditEntry {
    id: string;
    occurredAt: string;
    actorSub: string;
    actorJti: string;
    sourceIp: string | null;
    action: 'halt' | 'resume';
    reason: string;
    flattenRequested: boolean;
    previousState: 'running' | 'halted';
    newState: 'running' | 'halted';
    correlationEventId: string | null;
}

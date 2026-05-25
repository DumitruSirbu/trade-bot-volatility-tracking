import { HaltSourceEnum } from '../enum/HaltSourceEnum.js';

export interface IKillSwitchState {
    haltState: 'running' | 'halted';
    haltedAt: string | null;
    haltReason: string | null;
    haltSource: HaltSourceEnum;
    flattenInProgress: boolean;
    lastTransitionAuditId: string;
}

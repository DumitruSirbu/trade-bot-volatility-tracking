import { HaltSourceEnum } from '../enum/HaltSourceEnum.js';
import { HaltStateEnum } from '../enum/HaltStateEnum.js';

export interface IHaltChangedEvent {
    readonly action: 'HALT' | 'RESUME';
    readonly state: HaltStateEnum;
    readonly source: HaltSourceEnum;
    readonly reason: string;
    readonly auditId: string;
    readonly occurredAt: string;
    readonly wasAlreadyHalted: boolean;
}

import { HaltSourceEnum } from '../enum/HaltSourceEnum.js';

export interface IRiskHaltEvent {
    source: HaltSourceEnum;
    reason: string;
    engagedAt: string;
    metrics: Record<string, string>;
}

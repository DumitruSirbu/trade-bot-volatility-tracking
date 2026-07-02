import { RebalanceTriggerSourceEnum } from '../enum/RebalanceTriggerSourceEnum.js';

export const UNIVERSE_REBALANCE_DUE_EVENT = 'universe.rebalance.due' as const;

export interface IUniverseRebalanceDueEvent {
    readonly nowMs: number;
    readonly triggerSource: RebalanceTriggerSourceEnum;
}

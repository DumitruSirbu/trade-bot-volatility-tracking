import { DeviationSideEnum } from '../enum/DeviationSideEnum.js';

export interface ITriggerResult {
    fired: boolean;
    side: DeviationSideEnum; // derived from sign(vwapDeviationPct)
    sigmaConditionMet: boolean;
    volumeConditionMet: boolean;
    minMoveConditionMet: boolean;
    maxMoveConditionMet: boolean;
}

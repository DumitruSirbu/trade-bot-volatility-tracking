import { PositionSideEnum } from '../enum/PositionSideEnum.js';
import { DriftCaseEnum } from '../enum/DriftCaseEnum.js';

export interface IReconciliationDriftDetectedEvent {
    readonly positionId: number | null;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly driftCase: DriftCaseEnum;
    readonly dbQty: string | null;
    readonly exchangeQty: string | null;
    readonly detectedAtMs: number;
}

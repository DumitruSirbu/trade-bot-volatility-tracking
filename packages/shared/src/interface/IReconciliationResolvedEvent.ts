import { DriftCaseEnum } from '../enum/DriftCaseEnum.js';
import { ReconciliationOutcomeEnum } from '../enum/ReconciliationOutcomeEnum.js';

export interface IReconciliationResolvedEvent {
	readonly positionId: number;
	readonly driftCase: DriftCaseEnum;
	readonly outcome: ReconciliationOutcomeEnum;
	readonly resolvedAtMs: number;
}

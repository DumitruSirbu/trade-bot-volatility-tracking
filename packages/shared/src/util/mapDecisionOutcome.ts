import { DecisionOutcomeEnum } from '../enum/DecisionOutcomeEnum.js';
import { SignalActionEnum } from '../enum/SignalActionEnum.js';

export interface IDecisionOutcomeInput {
    readonly action: SignalActionEnum | string;
    readonly gateAllowed: boolean | null | undefined;
    readonly positionId: string | number | null | undefined;
}

/**
 * Derives the operator-facing outcome from persisted decision fields.
 * `action` is intent; `outcome` is gate + execution linkage (M41 D1).
 */
export function mapDecisionOutcome(input: IDecisionOutcomeInput): DecisionOutcomeEnum {
    const positionId = input.positionId;

    if (positionId !== null && positionId !== undefined && positionId !== '') {
        return DecisionOutcomeEnum.FILLED;
    }

    if (input.action === SignalActionEnum.SKIP) {
        return DecisionOutcomeEnum.SKIPPED;
    }

    if (input.action === SignalActionEnum.OPEN && input.gateAllowed === false) {
        return DecisionOutcomeEnum.REJECTED;
    }

    if (input.action === SignalActionEnum.OPEN && input.gateAllowed === true) {
        return DecisionOutcomeEnum.APPROVED;
    }

    if (input.gateAllowed === false) {
        return DecisionOutcomeEnum.REJECTED;
    }

    if (input.gateAllowed === true) {
        return DecisionOutcomeEnum.APPROVED;
    }

    return DecisionOutcomeEnum.SKIPPED;
}

import { DecisionOutcomeEnum, mapDecisionOutcome, SignalActionEnum } from '../../index.js';

describe('mapDecisionOutcome', () => {
    it('returns filled when position_id is set', () => {
        expect(
            mapDecisionOutcome({
                action: SignalActionEnum.OPEN,
                gateAllowed: true,
                positionId: '42',
            }),
        ).toBe(DecisionOutcomeEnum.FILLED);
    });

    it('returns skipped for skip action', () => {
        expect(
            mapDecisionOutcome({
                action: SignalActionEnum.SKIP,
                gateAllowed: null,
                positionId: null,
            }),
        ).toBe(DecisionOutcomeEnum.SKIPPED);
    });

    it('returns rejected for open intent with gate_allowed=false', () => {
        expect(
            mapDecisionOutcome({
                action: SignalActionEnum.OPEN,
                gateAllowed: false,
                positionId: null,
            }),
        ).toBe(DecisionOutcomeEnum.REJECTED);
    });

    it('returns approved for open intent with gate_allowed=true and no position', () => {
        expect(
            mapDecisionOutcome({
                action: SignalActionEnum.OPEN,
                gateAllowed: true,
                positionId: null,
            }),
        ).toBe(DecisionOutcomeEnum.APPROVED);
    });
});

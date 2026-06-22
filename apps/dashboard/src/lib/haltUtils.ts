import { HaltStateEnum, type IKillSwitchState } from '@bot/shared';

// Single source of truth for "is the engine halted?" across the banner and the
// kill-switch button. State-authoritative: when the halt-state query has
// resolved, its `haltState` is definitive; `risk?.isHalted` is only the
// fallback for the window before that query has loaded.
export const resolveHalted = (state: IKillSwitchState | undefined, riskHalted: boolean | undefined): boolean => {
    if (state !== undefined) {
        return state.haltState === HaltStateEnum.HALTED;
    }

    return riskHalted === true;
};

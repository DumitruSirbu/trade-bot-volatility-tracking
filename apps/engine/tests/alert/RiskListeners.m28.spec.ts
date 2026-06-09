/**
 * RiskListeners — M28 same_bar leg eligibility (ADR 0004 §6e, D7)
 *
 * Surfaces under test:
 *   RL_M28_1 — onMarketStressResumed with triggerLeg='same_bar' clears in-memory halt flag
 *   RL_M28_2 — onMarketStressResumed with triggerLeg='multi' does NOT clear halt flag
 *              (unexpectedLeg warning, no resume, no note)
 */

import { IMarketStressResumedEvent } from '@bot/shared';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { RiskListeners } from '../../src/alert/listeners/RiskListeners';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');

function buildResumedEvent(overrides: Partial<IMarketStressResumedEvent> = {}): IMarketStressResumedEvent {
    return {
        triggerLeg: 'same_bar',
        clearCount: 2,
        breadthAtResume: 45,
        dailyReHaltCount: 0,
        utcDateString: '2026-06-09',
        nearReHaltCap: false,
        ...overrides,
    };
}

function buildListeners(
    haltedAtStart = false,
    haltReason = 'market_stress:same_bar',
): {
    listeners: RiskListeners;
    haltFlag: HaltFlagService;
    haltService: { notePragmaticAutoClear: jest.Mock; notePragmaticTransition: jest.Mock };
    alertPublish: jest.Mock;
} {
    const haltFlag = new HaltFlagService();

    if (haltedAtStart) {
        haltFlag.halt(haltReason);
    }

    const haltService = {
        notePragmaticAutoClear: jest.fn(),
        notePragmaticTransition: jest.fn(),
    };

    const alertPublish = jest.fn().mockResolvedValue(undefined);
    const alerts = { publish: alertPublish };
    const clock = { now: () => FIXED_NOW };

    const listeners = new RiskListeners(haltFlag, alerts as any, clock as any, haltService as any);

    return { listeners, haltFlag, haltService, alertPublish };
}

// ─── RL_M28_1: same_bar triggerLeg clears the halt flag ──────────────────────

describe('RiskListeners M28 — RL_M28_1: onMarketStressResumed with triggerLeg="same_bar" clears halt flag', () => {
    it('haltFlag.isHalted() is false after MARKET_STRESS_RESUMED_EVENT with triggerLeg="same_bar"', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        expect(haltFlag.isHalted()).toBe(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'same_bar' }));

        expect(haltFlag.isHalted()).toBe(false);
    });

    it('haltFlag.getReason() is null after same_bar auto-resume', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'same_bar' }));

        expect(haltFlag.getReason()).toBeNull();
    });

    it('notePragmaticAutoClear is called with auto_resume:same_bar reason', async () => {
        const { listeners, haltService } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'same_bar' }));

        expect(haltService.notePragmaticAutoClear).toHaveBeenCalledTimes(1);
        expect(haltService.notePragmaticAutoClear).toHaveBeenCalledWith(
            'market_stress', // HaltSourceEnum.MARKET_STRESS
            'auto_resume:same_bar',
            FIXED_NOW.getTime(),
        );
    });
});

// ─── RL_M28_2: 'multi' triggerLeg is rejected — halt flag unchanged ───────────

describe('RiskListeners M28 — RL_M28_2: onMarketStressResumed with triggerLeg="multi" does NOT clear halt flag', () => {
    it('haltFlag stays halted when triggerLeg="multi" (not an eligible leg)', async () => {
        const { listeners, haltFlag } = buildListeners(true, 'market_stress:multi');

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'multi' }));

        expect(haltFlag.isHalted()).toBe(true);
    });

    it('notePragmaticAutoClear is NOT called when triggerLeg="multi"', async () => {
        const { listeners, haltService } = buildListeners(true, 'market_stress:multi');

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'multi' }));

        expect(haltService.notePragmaticAutoClear).not.toHaveBeenCalled();
    });

    it('no alert published when triggerLeg="multi"', async () => {
        const { listeners, alertPublish } = buildListeners(true, 'market_stress:multi');

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'multi' }));

        expect(alertPublish).not.toHaveBeenCalled();
    });
});

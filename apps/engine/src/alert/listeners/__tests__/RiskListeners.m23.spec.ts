/**
 * RiskListeners — M23 breadth auto-resume (ADR 0004 §6d)
 *
 * Surfaces under test:
 *   RL1  — onMarketStressResumed clears in-memory halt flag when halted
 *   RL2  — onMarketStressResumed calls notePragmaticAutoClear with correct args
 *   RL3  — onMarketStressResumed publishes INFO alert with MARKET_STRESS_RESUMED type
 *   RL4  — onMarketStressResumed is a no-op when already running (no flag clear, no note)
 *   RL5  — onRiskHalt builds halt reason as 'source:leg' not 'source:source' (double-prefix fix)
 *   RL6  — defense-in-depth: unexpected triggerLeg skips flag clear, note, and alert
 *   RL7  — end-to-end: real HaltService.getState() reports 'running' after auto-resume
 */

import { AlertSeverityEnum, AlertTypeEnum, HaltSourceEnum, HaltStateEnum, IMarketStressResumedEvent } from '@bot/shared';

import { HaltFlagService } from '../../../common/service/HaltFlagService';
import { HaltService } from '../../../control/HaltService';
import { RiskListeners } from '../RiskListeners';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-06T10:00:00.000Z');

function buildResumedEvent(overrides: Partial<IMarketStressResumedEvent> = {}): IMarketStressResumedEvent {
    return {
        triggerLeg: 'breadth',
        clearCount: 3,
        breadthAtResume: 45,
        dailyReHaltCount: 0,
        utcDateString: '2026-06-06',
        nearReHaltCap: false,
        ...overrides,
    };
}

function buildListeners(haltedAtStart = false): {
    listeners: RiskListeners;
    haltFlag: HaltFlagService;
    haltService: { notePragmaticAutoClear: jest.Mock; notePragmaticTransition: jest.Mock };
    alertPublish: jest.Mock;
} {
    const haltFlag = new HaltFlagService();

    if (haltedAtStart) {
        haltFlag.halt('market_stress:breadth');
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

// ─── RL1: onMarketStressResumed clears the halt flag ─────────────────────────

describe('RiskListeners M23 — RL1: onMarketStressResumed clears halt flag', () => {
    it('haltFlag.isHalted() is false after MARKET_STRESS_RESUMED_EVENT fires', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        expect(haltFlag.isHalted()).toBe(true);

        await listeners.onMarketStressResumed(buildResumedEvent());

        expect(haltFlag.isHalted()).toBe(false);
    });

    it('haltFlag.getReason() is null after auto-resume', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent());

        expect(haltFlag.getReason()).toBeNull();
    });

    it('haltFlag.getHaltedLeg() is null after auto-resume', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent());

        expect(haltFlag.getHaltedLeg()).toBeNull();
    });
});

// ─── RL2: notePragmaticAutoClear called with correct args ─────────────────────

describe('RiskListeners M23 — RL2: notePragmaticAutoClear called correctly', () => {
    it('calls notePragmaticAutoClear with MARKET_STRESS source and auto_resume:breadth reason', async () => {
        const { listeners, haltService } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'breadth' }));

        expect(haltService.notePragmaticAutoClear).toHaveBeenCalledTimes(1);
        expect(haltService.notePragmaticAutoClear).toHaveBeenCalledWith(HaltSourceEnum.MARKET_STRESS, 'auto_resume:breadth', FIXED_NOW.getTime());
    });

    it('notePragmaticAutoClear NOT called when haltFlag was already running (no transition to record)', async () => {
        const { listeners, haltService } = buildListeners(false);

        await listeners.onMarketStressResumed(buildResumedEvent());

        expect(haltService.notePragmaticAutoClear).not.toHaveBeenCalled();
    });
});

// ─── RL3: INFO alert published with MARKET_STRESS_RESUMED type ───────────────

describe('RiskListeners M23 — RL3: alert published on auto-resume', () => {
    it('publishes an INFO alert with MARKET_STRESS_RESUMED type', async () => {
        const { listeners, alertPublish } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ breadthAtResume: 45, dailyReHaltCount: 1 }));

        expect(alertPublish).toHaveBeenCalledTimes(1);

        const [payload] = alertPublish.mock.calls[0] as [{ type: AlertTypeEnum; severity: AlertSeverityEnum }];

        expect(payload.type).toBe(AlertTypeEnum.MARKET_STRESS_RESUMED);
        expect(payload.severity).toBe(AlertSeverityEnum.INFO);
    });

    it('alert data includes triggerLeg, breadthAtResume, dailyReHaltCount, nearReHaltCap', async () => {
        const { listeners, alertPublish } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'breadth', breadthAtResume: 47.5, dailyReHaltCount: 2, nearReHaltCap: true }));

        const [payload] = alertPublish.mock.calls[0] as [{ data: Record<string, string> }];

        expect(payload.data.triggerLeg).toBe('breadth');
        expect(payload.data.breadthAtResume).toBe('47.5');
        expect(payload.data.dailyReHaltCount).toBe('2');
        expect(payload.data.nearReHaltCap).toBe('true');
    });
});

// ─── RL4: idempotency — no double-resume when already running ─────────────────

describe('RiskListeners M23 — RL4: haltFlag.resume() not called when already running', () => {
    it('haltFlag.isHalted() stays false and handler completes without error', async () => {
        const { listeners, haltFlag } = buildListeners(false);

        await expect(listeners.onMarketStressResumed(buildResumedEvent())).resolves.toBeUndefined();

        expect(haltFlag.isHalted()).toBe(false);
    });
});

// ─── RL6: defense-in-depth leg guard — unexpected leg skips flag clear ────────

describe('RiskListeners M23 — RL6: unexpected triggerLeg is rejected (defense-in-depth)', () => {
    it('non-breadth leg: haltFlag stays halted when event has triggerLeg="multi"', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'multi' }));

        expect(haltFlag.isHalted()).toBe(true);
    });

    it('non-breadth leg: notePragmaticAutoClear is NOT called', async () => {
        const { listeners, haltService } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'btc_shock' }));

        expect(haltService.notePragmaticAutoClear).not.toHaveBeenCalled();
    });

    it('non-breadth leg: no alert is published', async () => {
        const { listeners, alertPublish } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'spread' }));

        expect(alertPublish).not.toHaveBeenCalled();
    });

    it('breadth leg still resumes normally', async () => {
        const { listeners, haltFlag } = buildListeners(true);

        await listeners.onMarketStressResumed(buildResumedEvent({ triggerLeg: 'breadth' }));

        expect(haltFlag.isHalted()).toBe(false);
    });
});

// ─── RL5: double-prefix fix — halt reason is 'market_stress:<leg>' not 'market_stress:market_stress' ─

describe('RiskListeners M23 — RL5: onRiskHalt builds correct halt reason (no double-prefix)', () => {
    it('haltFlag reason is market_stress:breadth when event reason is breadth', async () => {
        const { listeners, haltFlag } = buildListeners(false);

        await listeners.onRiskHalt({
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'breadth',
            engagedAt: FIXED_NOW.toISOString(),
            metrics: {},
        });

        expect(haltFlag.getReason()).toBe('market_stress:breadth');
    });

    it('haltFlag reason is market_stress:multi when event reason is multi', async () => {
        const { listeners, haltFlag } = buildListeners(false);

        await listeners.onRiskHalt({
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'multi',
            engagedAt: FIXED_NOW.toISOString(),
            metrics: {},
        });

        expect(haltFlag.getReason()).toBe('market_stress:multi');
    });
});

// ─── RL7: end-to-end — real HaltService.getState() reports 'running' after auto-resume ─

describe('RiskListeners M23 — RL7: HaltService.getState() is correct after auto-resume', () => {
    function buildWithRealHaltService(): { listeners: RiskListeners; haltFlag: HaltFlagService; haltService: HaltService } {
        const haltFlag = new HaltFlagService();
        haltFlag.halt('market_stress:breadth');

        const haltService = new HaltService(
            {} as any, // auditRepo — not called by notePragmaticAutoClear
            haltFlag,
            { publish: jest.fn() } as any,
            {} as any, // flattenCoordinator — not called
            {} as any, // riskHaltState — not called
            { emit: jest.fn() } as any,
        );

        const alertPublish = jest.fn().mockResolvedValue(undefined);
        const clock = { now: () => FIXED_NOW };
        const listeners = new RiskListeners(haltFlag, { publish: alertPublish } as any, clock as any, haltService);

        return { listeners, haltFlag, haltService };
    }

    it('getState().haltState is RUNNING after breadth auto-resume event', async () => {
        const { listeners, haltService } = buildWithRealHaltService();

        await listeners.onMarketStressResumed(buildResumedEvent());

        expect(haltService.getState().haltState).toBe(HaltStateEnum.RUNNING);
    });

    it('getState().haltState is HALTED before auto-resume', () => {
        const { haltService } = buildWithRealHaltService();

        // before the event fires the flag is still set
        expect(haltService.getState().haltState).toBe(HaltStateEnum.HALTED);
    });
});

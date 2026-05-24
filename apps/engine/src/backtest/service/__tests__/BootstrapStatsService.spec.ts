/**
 * BootstrapStatsService — pairwise paired block bootstrap (M8 W5b, ADR 0018).
 *
 * Surfaces under test:
 *   B1 — sample-size gate: < 200 OPEN trades per candidate → `inconclusive` with reason
 *        `insufficient_samples`; counters reflect actual values.
 *   B2 — happy path: a 200+ event fixture with synthetic deterministic `r` values
 *        produces a `conclusive` result whose CI sign matches the constructed advantage.
 *   B3 — determinism: same runLabel + same tape → byte-identical CI on a re-run.
 *   B4 — pair generation: 4 versions → 6 pairs in `(i, j)`-ordered emission.
 *   B5 — multiple-comparison note: emitted for ≥2 pairs; null for 1 pair / 0 pairs.
 */

import { FlowTypeEnum, RegimeLabelEnum } from '@bot/shared';

import { IComparisonEventOutcome } from '../../interface/IComparisonEventOutcome';
import { BootstrapStatsService } from '../BootstrapStatsService';

function buildOutcome(
    eventId: string,
    triggerTs: number,
    rByVersion: ReadonlyMap<number, { r: number; action: 'open' | 'skip' | 'missed' }>,
): IComparisonEventOutcome {
    const outcomesByVersion = new Map();

    for (const [versionId, payload] of rByVersion) {
        outcomesByVersion.set(versionId, {
            action: payload.action,
            rPerUnitRisk: payload.r,
        });
    }

    return {
        eventId,
        symbol: 'ETHUSDT',
        triggerTs,
        regime: RegimeLabelEnum.RANGING,
        flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
        outcomesByVersion,
    };
}

// Build N outcomes where versionA's `r` exceeds versionB's by `advantage` on every
// event (with a small zero-mean noise term to give the bootstrap a non-degenerate
// variance estimate). The synthetic noise is deterministic — no Math.random.
function buildSyntheticTape(eventCount: number, advantage: number, opens = true): IComparisonEventOutcome[] {
    const outcomes: IComparisonEventOutcome[] = [];

    for (let i = 0; i < eventCount; i += 1) {
        // Triangle-wave noise — bounded, mean-zero, deterministic in i.
        const noise = ((i % 7) - 3) * 0.01;
        const rA = 0.05 + advantage / 2 + noise;
        const rB = 0.05 - advantage / 2 - noise;

        const map = new Map<number, { r: number; action: 'open' | 'skip' | 'missed' }>();
        map.set(1, { r: rA, action: opens ? 'open' : 'skip' });
        map.set(2, { r: rB, action: opens ? 'open' : 'skip' });

        outcomes.push(buildOutcome(`E:${i}`, 1700_000_000_000 + i * 60_000, map));
    }

    return outcomes;
}

describe('BootstrapStatsService.computePairwiseStats', () => {
    // B1 — gate failure when neither candidate hits 200 opens.
    it('emits `inconclusive` with `insufficient_samples` when fewer than 200 opens per candidate', () => {
        const service = new BootstrapStatsService();
        const tape = buildSyntheticTape(100, 0.1);

        const result = service.computePairwiseStats(tape, [1, 2], 'run-A');

        expect(result).toHaveLength(1);
        expect(result[0].outcome).toBe('inconclusive');
        if (result[0].outcome === 'inconclusive') {
            expect(result[0].reason).toBe('insufficient_samples');
            expect(result[0].countersByGate.tradesA).toBe(100);
            expect(result[0].countersByGate.tradesB).toBe(100);
        }
    });

    // B1b — gate failure when only opens for one side exceed 200 but the other does not.
    it('emits `inconclusive` when only one candidate has the required open count', () => {
        const service = new BootstrapStatsService();
        // 250 events; version 2 skips every event. Both sides need ≥ 200 OPENS to pass.
        const tape: IComparisonEventOutcome[] = [];
        for (let i = 0; i < 250; i += 1) {
            const map = new Map<number, { r: number; action: 'open' | 'skip' | 'missed' }>();
            map.set(1, { r: 0.1, action: 'open' });
            map.set(2, { r: 0, action: 'skip' });
            tape.push(buildOutcome(`E:${i}`, i, map));
        }

        const result = service.computePairwiseStats(tape, [1, 2], 'run-B');

        expect(result[0].outcome).toBe('inconclusive');
    });

    // B2 — happy path: A advantage > 0 with enough samples → CI strictly above zero.
    it('produces a conclusive result whose CI sign matches the constructed advantage (A > B)', () => {
        const service = new BootstrapStatsService();
        // 250 events, A advantage of 0.10 per event. Noise is bounded ±0.03, advantage
        // dominates — CI must lie above zero.
        const tape = buildSyntheticTape(250, 0.1);

        const result = service.computePairwiseStats(tape, [1, 2], 'happy-A');

        expect(result).toHaveLength(1);
        const r = result[0];
        expect(r.outcome).toBe('conclusive');
        if (r.outcome === 'conclusive') {
            expect(r.versionA).toBe(1);
            expect(r.versionB).toBe(2);
            expect(r.winner).toBe('A');
            expect(r.ci95Low).toBeGreaterThan(0);
            expect(r.ci95High).toBeGreaterThan(r.ci95Low);
            expect(r.n).toBe(10000);
            expect(r.blockLen).toBeGreaterThanOrEqual(4);
        }
    });

    // B2b — symmetry: A < B → winner B, CI below zero.
    it('produces winner=B when B has the advantage', () => {
        const service = new BootstrapStatsService();
        const tape = buildSyntheticTape(250, -0.1); // A disadvantage

        const result = service.computePairwiseStats(tape, [1, 2], 'happy-B');
        const r = result[0];

        expect(r.outcome).toBe('conclusive');
        if (r.outcome === 'conclusive') {
            expect(r.winner).toBe('B');
            expect(r.ci95High).toBeLessThan(0);
        }
    });

    // B3 — determinism across two service instances with the same inputs.
    it('returns byte-identical CI on two runs with the same runLabel + tape', () => {
        const tapeA = buildSyntheticTape(250, 0.1);
        const tapeB = buildSyntheticTape(250, 0.1);

        const r1 = new BootstrapStatsService().computePairwiseStats(tapeA, [1, 2], 'same-seed');
        const r2 = new BootstrapStatsService().computePairwiseStats(tapeB, [1, 2], 'same-seed');

        expect(r1[0].outcome).toBe('conclusive');
        expect(r2[0].outcome).toBe('conclusive');
        if (r1[0].outcome === 'conclusive' && r2[0].outcome === 'conclusive') {
            expect(r1[0].ci95Low).toBe(r2[0].ci95Low);
            expect(r1[0].ci95High).toBe(r2[0].ci95High);
            expect(r1[0].meanDiff).toBe(r2[0].meanDiff);
            expect(r1[0].blockLen).toBe(r2[0].blockLen);
        }
    });

    // B3b — different runLabel produces a different CI (seed isolation).
    it('produces different CI endpoints for different runLabels on the same tape', () => {
        const tape = buildSyntheticTape(250, 0.1);

        const r1 = new BootstrapStatsService().computePairwiseStats(tape, [1, 2], 'label-A');
        const r2 = new BootstrapStatsService().computePairwiseStats(tape, [1, 2], 'label-B');

        if (r1[0].outcome === 'conclusive' && r2[0].outcome === 'conclusive') {
            // Mean diff is fixed by the data; only the CI endpoints depend on the seed.
            expect(r1[0].meanDiff).toBe(r2[0].meanDiff);
            // CI endpoints differ — extremely unlikely to collide with two unrelated FNV seeds.
            expect([r1[0].ci95Low === r2[0].ci95Low, r1[0].ci95High === r2[0].ci95High]).not.toEqual([true, true]);
        }
    });

    // B4 — 4 versions → 6 pairs.
    it('emits one result per ordered pair (n choose 2) for n >= 2 versions', () => {
        const service = new BootstrapStatsService();
        const tape = buildSyntheticTape(10, 0); // gate fails; we only care about pair count

        const result = service.computePairwiseStats(tape, [1, 2, 3, 4], 'four-vs');

        expect(result).toHaveLength(6);
        const pairs = result.map((r) => `${r.versionA}-${r.versionB}`);
        expect(pairs).toEqual(['1-2', '1-3', '1-4', '2-3', '2-4', '3-4']);
    });

    // B4b — single version → zero pairs.
    it('emits zero pairs for a single-version comparison', () => {
        const service = new BootstrapStatsService();
        const result = service.computePairwiseStats([], [1], 'single');
        expect(result).toHaveLength(0);
    });
});

describe('BootstrapStatsService.buildMultipleComparisonNote', () => {
    it('emits null when only one pair exists', () => {
        const service = new BootstrapStatsService();
        expect(service.buildMultipleComparisonNote([1, 2])).toBeNull();
        expect(service.buildMultipleComparisonNote([1])).toBeNull();
        expect(service.buildMultipleComparisonNote([])).toBeNull();
    });

    it('emits a note referencing the pair count for >= 2 pairs', () => {
        const service = new BootstrapStatsService();
        const note = service.buildMultipleComparisonNote([1, 2, 3, 4]);
        expect(note).not.toBeNull();
        expect(note).toContain('6'); // 4 choose 2
    });
});

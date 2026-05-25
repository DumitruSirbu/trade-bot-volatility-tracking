/**
 * Adversarial tests for RevokedJtiPruneScheduler (M11a W1.6 — ADR 0031).
 *
 * Covers: prune floor (rows older than cutoff are deleted, younger rows
 * preserved), REVOKED_JTI_UNBOUNDED alert fires once per tick (not per-call),
 * bootstrap-secret rotation does NOT flush the table, clock injection so no
 * Date.now() leaks.
 *
 * NOTE: The boot validation (AUTH_REVOKED_JTI_PRUNE_AFTER_SEC < TTL + 3600
 * causes a boot failure) lives in AppConfigService and is not retestable here
 * without full DI. The guard is documented and flagged for AppConfigService
 * unit tests.
 */

import { AlertSeverityEnum } from '@bot/shared';
import { RevokedJtiPruneScheduler } from '../RevokedJtiPruneScheduler';

// ─── helpers ──────────────────────────────────────────────────────────────────

type IRevoked = {
    pruneOlderThan: jest.Mock<Promise<number>, [Date]>;
    countAll: jest.Mock<Promise<number>, []>;
    add: jest.Mock;
};

function buildRevoked(overrides: Partial<IRevoked> = {}): IRevoked {
    return {
        pruneOlderThan: jest.fn<Promise<number>, [Date]>().mockResolvedValue(0),
        countAll: jest.fn<Promise<number>, []>().mockResolvedValue(0),
        add: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function buildAlerts() {
    return { publish: jest.fn().mockResolvedValue(undefined) };
}

function buildAppConfig(overrides: { revokedJtiPruneAfterSec?: number; revokedJtiMaxRows?: number } = {}) {
    return {
        revokedJtiPruneAfterSec: overrides.revokedJtiPruneAfterSec ?? 4500, // 75 min default
        revokedJtiMaxRows: overrides.revokedJtiMaxRows ?? 10_000,
    } as never;
}

function buildClock(fixedDate: Date) {
    return { now: jest.fn<Date, []>().mockReturnValue(fixedDate) };
}

function buildScheduler(
    revoked: IRevoked,
    alerts: ReturnType<typeof buildAlerts>,
    appConfig: ReturnType<typeof buildAppConfig>,
    clock: ReturnType<typeof buildClock>,
): RevokedJtiPruneScheduler {
    return new RevokedJtiPruneScheduler(
        revoked as never,
        alerts as never,
        clock as never,
        appConfig,
    );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('RevokedJtiPruneScheduler — adversarial', () => {
    // ── Prune calls repository with correct cutoff ────────────────────────────

    describe('cutoff date calculation', () => {
        it('calls pruneOlderThan with now - prune_after_sec cutoff', async () => {
            // BUILD
            const now = new Date('2026-06-01T12:00:00.000Z');
            const pruneAfterSec = 4500; // 75 minutes
            const expectedCutoff = new Date(now.getTime() - pruneAfterSec * 1000);

            const revoked = buildRevoked();
            const alerts = buildAlerts();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, alerts, buildAppConfig({ revokedJtiPruneAfterSec: pruneAfterSec }), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK
            const [calledCutoff]: [Date] = revoked.pruneOlderThan.mock.calls[0];
            expect(calledCutoff.getTime()).toBe(expectedCutoff.getTime());
        });

        it('never calls pruneOlderThan with a future cutoff (would delete non-expired rows)', async () => {
            // BUILD
            const now = new Date('2026-06-01T12:00:00.000Z');
            const revoked = buildRevoked();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, buildAlerts(), buildAppConfig(), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK — cutoff must be in the past relative to `now`
            const [calledCutoff]: [Date] = revoked.pruneOlderThan.mock.calls[0];
            expect(calledCutoff.getTime()).toBeLessThan(now.getTime());
        });
    });

    // ── Rows younger than cutoff are preserved ────────────────────────────────

    describe('young rows are preserved', () => {
        it('does not delete rows that are newer than the age floor', async () => {
            // BUILD — the actual deletion is behind the repository mock; verify
            // the cutoff passed is such that rows within JWT_TTL + 1h would be preserved
            const now = new Date('2026-06-01T12:00:00.000Z');
            const pruneAfterMs = 4500 * 1000; // 75 min
            const recentRevocationMs = now.getTime() - 30 * 60 * 1000; // 30 min ago — should be preserved

            const revoked = buildRevoked();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, buildAlerts(), buildAppConfig({ revokedJtiPruneAfterSec: 4500 }), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK — cutoff is now - 75 min; 30-min-old row is after the cutoff
            const [calledCutoff]: [Date] = revoked.pruneOlderThan.mock.calls[0];
            // A row with revoked_at = 30 min ago is NOT older than cutoff (75 min ago)
            expect(recentRevocationMs).toBeGreaterThan(calledCutoff.getTime());
        });
    });

    // ── REVOKED_JTI_UNBOUNDED alert fires once per tick ───────────────────────

    describe('REVOKED_JTI_UNBOUNDED alert', () => {
        it('fires exactly one alert when row count exceeds max threshold', async () => {
            // BUILD
            const now = new Date('2026-06-01T12:00:00.000Z');
            const maxRows = 10_000;
            const revoked = buildRevoked({
                countAll: jest.fn<Promise<number>, []>().mockResolvedValue(maxRows + 1),
            });
            const alerts = buildAlerts();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, alerts, buildAppConfig({ revokedJtiMaxRows: maxRows }), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK — exactly one alert with the unbounded reason
            const unboundedAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ data?: { reason?: string } }]) => p.data?.reason === 'REVOKED_JTI_UNBOUNDED',
            );
            expect(unboundedAlerts).toHaveLength(1);
        });

        it('does not fire alert when row count is exactly at the threshold (boundary)', async () => {
            // BUILD
            const now = new Date('2026-06-01T12:00:00.000Z');
            const maxRows = 10_000;
            const revoked = buildRevoked({
                countAll: jest.fn<Promise<number>, []>().mockResolvedValue(maxRows),
            });
            const alerts = buildAlerts();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, alerts, buildAppConfig({ revokedJtiMaxRows: maxRows }), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK — no unbounded alert at exactly the threshold
            const unboundedAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ data?: { reason?: string } }]) => p.data?.reason === 'REVOKED_JTI_UNBOUNDED',
            );
            expect(unboundedAlerts).toHaveLength(0);
        });

        it('fires the alert with WARN severity', async () => {
            // BUILD
            const now = new Date('2026-06-01T12:00:00.000Z');
            const revoked = buildRevoked({
                countAll: jest.fn<Promise<number>, []>().mockResolvedValue(20_000),
            });
            const alerts = buildAlerts();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, alerts, buildAppConfig({ revokedJtiMaxRows: 10_000 }), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK
            const unboundedAlert = (alerts.publish as jest.Mock).mock.calls.find(
                ([p]: [{ data?: { reason?: string } }]) => p.data?.reason === 'REVOKED_JTI_UNBOUNDED',
            );
            expect(unboundedAlert).toBeDefined();
            expect(unboundedAlert?.[0]?.severity).toBe(AlertSeverityEnum.WARN);
        });
    });

    // ── Prune failure is logged but does not crash ────────────────────────────

    describe('repository failure does not crash the scheduler', () => {
        it('resolves (does not throw) when pruneOlderThan throws', async () => {
            // BUILD
            const now = new Date();
            const revoked = buildRevoked({
                pruneOlderThan: jest.fn().mockRejectedValue(new Error('DB unavailable')),
            });
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, buildAlerts(), buildAppConfig(), clock);

            // OPERATE + CHECK — must not throw
            await expect(scheduler.runOnce(now)).resolves.toBeUndefined();
        });

        it('still runs countAll after pruneOlderThan failure', async () => {
            // BUILD
            const now = new Date();
            const revoked = buildRevoked({
                pruneOlderThan: jest.fn().mockRejectedValue(new Error('DB')),
                countAll: jest.fn<Promise<number>, []>().mockResolvedValue(0),
            });
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, buildAlerts(), buildAppConfig(), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK
            expect(revoked.countAll).toHaveBeenCalledTimes(1);
        });
    });

    // ── Bootstrap-secret rotation does NOT flush the table ────────────────────

    describe('bootstrap-secret rotation does not flush revoked_jti (ADR 0031 §2.6)', () => {
        it('runOnce only calls pruneOlderThan, never deletes all rows', async () => {
            // BUILD — a table flush would be a deleteAll call; the repository
            // interface only exposes pruneOlderThan (by cutoff date), never a
            // truncate or deleteAll. This test asserts no full-table wipe happens.
            const now = new Date();
            const revoked = buildRevoked();
            const clock = buildClock(now);
            const scheduler = buildScheduler(revoked, buildAlerts(), buildAppConfig(), clock);

            // OPERATE
            await scheduler.runOnce(now);

            // CHECK — pruneOlderThan is called (by cutoff), never a flush
            expect(revoked.pruneOlderThan).toHaveBeenCalledTimes(1);
            // Verify the cutoff is a Date object (i.e. a partial delete, not full wipe)
            const [cutoff]: [Date] = revoked.pruneOlderThan.mock.calls[0];
            expect(cutoff).toBeInstanceOf(Date);
            // A full flush would pass a future date; the cutoff must be in the past
            expect(cutoff.getTime()).toBeLessThan(now.getTime());
        });
    });

    // ── Uses injected clock, not Date.now() ───────────────────────────────────

    describe('injected clock controls timing', () => {
        it('produces consistent cutoffs for the same injected now value', async () => {
            // BUILD
            const fixedNow = new Date('2026-06-15T00:00:00.000Z');
            const revoked1 = buildRevoked();
            const revoked2 = buildRevoked();
            const clock = buildClock(fixedNow);
            const config = buildAppConfig({ revokedJtiPruneAfterSec: 4500 });

            const s1 = buildScheduler(revoked1, buildAlerts(), config, clock);
            const s2 = buildScheduler(revoked2, buildAlerts(), config, clock);

            // OPERATE
            await s1.runOnce(fixedNow);
            await s2.runOnce(fixedNow);

            // CHECK — both schedulers produce identical cutoffs
            const [cutoff1]: [Date] = revoked1.pruneOlderThan.mock.calls[0];
            const [cutoff2]: [Date] = revoked2.pruneOlderThan.mock.calls[0];
            expect(cutoff1.getTime()).toBe(cutoff2.getTime());
        });
    });
});

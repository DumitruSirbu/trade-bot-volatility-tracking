// M13 W5.A — wallclock-exceeded semantics for the agent entry-point.
//
// We test the extracted `runUnderWallclock` seam directly (no child process)
// because the wallclock + history-record contract is the unit under test;
// the spawn shape is covered by the lockfile spec.
//
// Two cases:
//   1. The loop never resolves → wallclock timer fires → onWallclockExceeded
//      is invoked with a FAILED/WALLCLOCK_EXCEEDED-shaped row and exit is 1.
//   2. SIGTERM is delivered before the timer fires → same outcome (the
//      external scheduler signalled abort).

import { TerminalStateEnum } from '@bot/shared';
import pino from 'pino';

import { runUnderWallclock, WallclockExceededError, computeEffectiveLockStaleMs, LOCKFILE_STALE_MS, LOCK_STALE_SAFETY_MARGIN_MS } from '../../src/main.js';

function silentLogger(): pino.Logger {
    return pino({ level: 'silent' });
}

describe('runUnderWallclock', () => {
    it('fires the timer when the loop never resolves and records WALLCLOCK_EXCEEDED', async () => {
        const onWallclockExceeded = jest.fn().mockResolvedValue(undefined);
        const release = jest.fn().mockResolvedValue(undefined);

        const exitCode = await runUnderWallclock({
            wallclockMs: 50,
            logger: silentLogger(),
            runLoop: () => new Promise(() => undefined),
            onWallclockExceeded,
            release,
        });

        expect(exitCode).toBe(1);
        expect(onWallclockExceeded).toHaveBeenCalledTimes(1);
        expect(onWallclockExceeded.mock.calls[0][0]).toBeInstanceOf(Date);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('honours SIGTERM before the timer fires', async () => {
        const onWallclockExceeded = jest.fn().mockResolvedValue(undefined);
        const release = jest.fn().mockResolvedValue(undefined);

        // Fire SIGTERM right after starting the race.
        setImmediate(() => {
            process.emit('SIGTERM');
        });

        const exitCode = await runUnderWallclock({
            wallclockMs: 60_000,
            logger: silentLogger(),
            runLoop: () => new Promise(() => undefined),
            onWallclockExceeded,
            release,
        });

        expect(exitCode).toBe(1);
        expect(onWallclockExceeded).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('returns 0 and skips the wallclock-history hook when the loop completes in time', async () => {
        const onWallclockExceeded = jest.fn().mockResolvedValue(undefined);
        const release = jest.fn().mockResolvedValue(undefined);

        const exitCode = await runUnderWallclock({
            wallclockMs: 1_000,
            logger: silentLogger(),
            runLoop: async () => ({
                terminalState: TerminalStateEnum.COMPLETED,
                draftVersionId: 1,
                reportPaths: null,
                failureReason: null,
                bootstrapCiLo: null,
                bootstrapCiHi: null,
                passesPromotionGate: null,
            }),
            onWallclockExceeded,
            release,
        });

        expect(exitCode).toBe(0);
        expect(onWallclockExceeded).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('exports WallclockExceededError so callers can type-narrow', () => {
        const err = new WallclockExceededError();
        expect(err.name).toBe('WallclockExceededError');
    });
});

describe('computeEffectiveLockStaleMs (M13 W6 fix wave 2 #4)', () => {
    it('returns the LOCKFILE_STALE_MS default when the wallclock fits well inside it', () => {
        const wallclock = 45 * 60 * 1000;
        const stale = computeEffectiveLockStaleMs(wallclock);
        expect(stale).toBe(LOCKFILE_STALE_MS);
        expect(stale).toBeGreaterThan(wallclock);
    });

    it('extends the stale window past wallclock + safety margin when the override is large', () => {
        const wallclock = 4 * 60 * 60 * 1000; // 4h — well above the 90-min default
        const stale = computeEffectiveLockStaleMs(wallclock);
        expect(stale).toBe(wallclock + LOCK_STALE_SAFETY_MARGIN_MS);
        expect(stale).toBeGreaterThan(wallclock);
    });

    it('always returns a value strictly greater than the wallclock budget', () => {
        for (const wc of [1_000, 60_000, 45 * 60 * 1000, 90 * 60 * 1000, 6 * 60 * 60 * 1000]) {
            const stale = computeEffectiveLockStaleMs(wc);
            expect(stale).toBeGreaterThan(wc);
        }
    });
});

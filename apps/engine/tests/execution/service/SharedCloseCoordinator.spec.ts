/**
 * SharedCloseCoordinator — M33 Fix 1b (ADR 0011 §9).
 *
 * The single in-memory dedup substrate for all gate-routed close producers. Coverage:
 *   1. tryAcquire returns false on a held slot (and true on a fresh one)
 *   2. release frees the slot (a subsequent tryAcquire succeeds)
 *   3. isHeld returns true only when held (non-destructive)
 */

import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';

describe('SharedCloseCoordinator', () => {
    it('tryAcquire returns false on a held slot', () => {
        // BUILD
        const coordinator = new SharedCloseCoordinator();

        // OPERATE
        const first = coordinator.tryAcquire(42);
        const second = coordinator.tryAcquire(42);

        // CHECK
        expect(first).toBe(true);
        expect(second).toBe(false);
    });

    it('release frees the slot', () => {
        // BUILD
        const coordinator = new SharedCloseCoordinator();
        coordinator.tryAcquire(7);

        // OPERATE
        coordinator.release(7);

        // CHECK: the slot can be acquired again after release
        expect(coordinator.tryAcquire(7)).toBe(true);
    });

    it('isHeld returns true only when held', () => {
        // BUILD
        const coordinator = new SharedCloseCoordinator();

        // CHECK: never acquired
        expect(coordinator.isHeld(99)).toBe(false);

        // OPERATE + CHECK: held after acquire
        coordinator.tryAcquire(99);
        expect(coordinator.isHeld(99)).toBe(true);

        // OPERATE + CHECK: not held after release
        coordinator.release(99);
        expect(coordinator.isHeld(99)).toBe(false);
    });
});

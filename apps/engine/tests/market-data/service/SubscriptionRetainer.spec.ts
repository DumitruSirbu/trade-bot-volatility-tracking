/**
 * SubscriptionRetainer — unit tests (M6 W2, ADR 0011 §5).
 *
 * Coverage:
 *   - Reason-set semantics: retain with two reasons → release one → still
 *     retained; release both → dropped.
 *   - Idempotent retain (same reason twice = single reason).
 *   - No-op release: releasing an unknown symbol or an absent reason does
 *     not throw and does not corrupt state.
 *   - getRetainedSymbols / getReasonsFor snapshot semantics: returned Sets
 *     are owned by the caller and do not mutate the internal registry.
 */

import { RetainReasonEnum } from '@bot/shared';

import { SubscriptionRetainer } from '../../../src/market-data/service/SubscriptionRetainer';

describe('SubscriptionRetainer — reason-set semantics (ADR 0011 §5)', () => {
    it('symbol stays retained while ANY reason is present; drops only when last reason releases', () => {
        // BUILD
        const retainer = new SubscriptionRetainer();

        // OPERATE: two independent producers retain the same symbol.
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.retain('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        // CHECK: both reasons active.
        expect(retainer.isRetained('BTCUSDT')).toBe(true);
        expect(retainer.getReasonsFor('BTCUSDT')).toEqual(new Set([RetainReasonEnum.OPEN_POSITION, RetainReasonEnum.COOLDOWN_ACTIVE]));

        // Release one — still retained.
        retainer.release('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('BTCUSDT')).toBe(true);
        expect(retainer.getReasonsFor('BTCUSDT')).toEqual(new Set([RetainReasonEnum.COOLDOWN_ACTIVE]));

        // Release the last — dropped.
        retainer.release('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(retainer.isRetained('BTCUSDT')).toBe(false);
        expect(retainer.getReasonsFor('BTCUSDT')).toEqual(new Set());
    });

    it('retain with the same reason twice is idempotent (single reason, no refcount)', () => {
        const retainer = new SubscriptionRetainer();

        retainer.retain('ETHUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.retain('ETHUSDT', RetainReasonEnum.OPEN_POSITION);

        // Single release drops the symbol — same-reason retain didn't refcount.
        retainer.release('ETHUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('ETHUSDT')).toBe(false);
    });

    it('retain returns same-shape view across all four reason values', () => {
        const retainer = new SubscriptionRetainer();
        const allReasons = [
            RetainReasonEnum.OPEN_POSITION,
            RetainReasonEnum.PENDING_RECONCILE,
            RetainReasonEnum.FOREIGN_ADOPTED,
            RetainReasonEnum.COOLDOWN_ACTIVE,
        ];

        for (const reason of allReasons) {
            retainer.retain('LTCUSDT', reason);
        }

        expect(retainer.getReasonsFor('LTCUSDT').size).toBe(4);
        expect(retainer.isRetained('LTCUSDT')).toBe(true);

        // Releasing 3 of 4 leaves the symbol retained.
        retainer.release('LTCUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.release('LTCUSDT', RetainReasonEnum.PENDING_RECONCILE);
        retainer.release('LTCUSDT', RetainReasonEnum.FOREIGN_ADOPTED);
        expect(retainer.isRetained('LTCUSDT')).toBe(true);

        retainer.release('LTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(retainer.isRetained('LTCUSDT')).toBe(false);
    });
});

describe('SubscriptionRetainer — adversarial / boundary', () => {
    it('release-without-prior-retain is a no-op (does not throw, does not mutate)', () => {
        const retainer = new SubscriptionRetainer();

        // No throw on never-retained symbol.
        expect(() => retainer.release('SOLUSDT', RetainReasonEnum.OPEN_POSITION)).not.toThrow();
        expect(retainer.isRetained('SOLUSDT')).toBe(false);

        // No throw / no mutation on present-symbol-absent-reason.
        retainer.retain('SOLUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(() => retainer.release('SOLUSDT', RetainReasonEnum.PENDING_RECONCILE)).not.toThrow();
        expect(retainer.getReasonsFor('SOLUSDT')).toEqual(new Set([RetainReasonEnum.OPEN_POSITION]));
    });

    it('getRetainedSymbols returns a snapshot, not a live view (caller-mutation safe)', () => {
        const retainer = new SubscriptionRetainer();

        retainer.retain('AVAXUSDT', RetainReasonEnum.OPEN_POSITION);
        const snapshot = retainer.getRetainedSymbols();
        snapshot.delete('AVAXUSDT'); // mutate the returned copy

        // Internal registry still holds the original.
        expect(retainer.isRetained('AVAXUSDT')).toBe(true);
    });

    it('getReasonsFor on an unretained symbol returns an empty Set (branch-free callers)', () => {
        const retainer = new SubscriptionRetainer();

        const reasons = retainer.getReasonsFor('DOTUSDT');
        expect(reasons).toBeInstanceOf(Set);
        expect(reasons.size).toBe(0);
    });

    it('getReasonsFor returns a snapshot (mutating the returned Set does not corrupt state)', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('XRPUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.retain('XRPUSDT', RetainReasonEnum.PENDING_RECONCILE);

        const snapshot = retainer.getReasonsFor('XRPUSDT');
        snapshot.clear();

        // Internal state intact.
        expect(retainer.getReasonsFor('XRPUSDT').size).toBe(2);
    });

    it('independent symbols are isolated (retaining one does not retain another)', () => {
        const retainer = new SubscriptionRetainer();

        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        expect(retainer.isRetained('BTCUSDT')).toBe(true);
        expect(retainer.isRetained('ETHUSDT')).toBe(false);
        expect(retainer.getRetainedSymbols()).toEqual(new Set(['BTCUSDT']));
    });
});

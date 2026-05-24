/**
 * PositionLifecycleRetentionListener — unit tests (M6 W2, ADR 0011 §5).
 *
 * Coverage matrix:
 *   - On transition into PENDING_OPEN, OPEN, RECONCILING, MANUAL_ADOPTED_UNMANAGED,
 *     CLOSED — each retains/releases the right reason class.
 *   - Cooldown wiring: CLOSED-with-negative-realized-pnl retains COOLDOWN_ACTIVE;
 *     CLOSED-with-positive-pnl does NOT.
 *   - Cooldown release-on-expiry: gap surfaced as it.todo (W4 follow-up).
 *   - From-RECONCILING leg: leaving RECONCILING to OPEN/MANUAL_ADOPTED releases
 *     PENDING_RECONCILE; leaving to CLOSED is also covered by the CLOSED block.
 *   - From-MANUAL_ADOPTED_UNMANAGED leg: leaving to OPEN/CLOSING releases
 *     FOREIGN_ADOPTED.
 *
 * M6 R1.3.4: the listener now reads symbol / exitReason / realizedPnl directly
 * from the event payload (no second DB round-trip via PositionRepository).
 * Tests build the payload with the relevant fields and assert routing on the
 * payload contract alone.
 */

import { ExitReasonEnum, IPositionStateTransitionedEvent, PositionStateEnum, RetainReasonEnum } from '@bot/shared';

import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionLifecycleRetentionListener } from '../../src/position/service/PositionLifecycleRetentionListener';

function buildHarness() {
    const retainer = new SubscriptionRetainer();
    const retainSpy = jest.spyOn(retainer, 'retain');
    const releaseSpy = jest.spyOn(retainer, 'release');
    const listener = new PositionLifecycleRetentionListener(retainer);

    return { listener, retainer, retainSpy, releaseSpy };
}

function buildEvent(overrides: Partial<IPositionStateTransitionedEvent> = {}): IPositionStateTransitionedEvent {
    return {
        positionId: 42,
        fromState: PositionStateEnum.PENDING_OPEN,
        toState: PositionStateEnum.OPEN,
        transitionedAtMs: 1_700_000_000_000,
        eventClass: 'unit.test',
        symbol: 'BTCUSDT',
        exitReason: null,
        realizedPnl: null,
        ...overrides,
    };
}

describe('PositionLifecycleRetentionListener — entry-side retentions (ADR 0011 §5 row 3-4)', () => {
    it('retains OPEN_POSITION on transition into PENDING_OPEN', () => {
        const { listener, retainer, retainSpy } = buildHarness();

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.OPEN, toState: PositionStateEnum.PENDING_OPEN }));

        expect(retainSpy).toHaveBeenCalledWith('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('BTCUSDT')).toBe(true);
    });

    it('retains OPEN_POSITION on transition into OPEN (e.g. PENDING_OPEN -> OPEN, the entry-happy-path edge)', () => {
        const { listener, retainer, retainSpy } = buildHarness();

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.PENDING_OPEN, toState: PositionStateEnum.OPEN }));

        expect(retainSpy).toHaveBeenCalledWith('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('BTCUSDT')).toBe(true);
    });
});

describe('PositionLifecycleRetentionListener — CLOSED releases everything (ADR 0011 §5 OPEN_POSITION line)', () => {
    it('releases OPEN_POSITION on transition into CLOSED', () => {
        // Use TAKE_PROFIT exit reason — the W4b narrowed predicate does NOT arm cooldown
        // for TP, so the symbol drops from the retainer once OPEN_POSITION is released.
        const { listener, retainer } = buildHarness();

        // Pre-arm to verify the release actually toggles state.
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('BTCUSDT')).toBe(true);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.CLOSING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.TAKE_PROFIT,
            }),
        );

        expect(retainer.isRetained('BTCUSDT')).toBe(false);
    });

    it('also releases PENDING_RECONCILE and FOREIGN_ADOPTED on CLOSED (defensive: a row might have stacked retentions)', () => {
        const { listener, retainer, releaseSpy } = buildHarness();

        retainer.retain('BTCUSDT', RetainReasonEnum.PENDING_RECONCILE);
        retainer.retain('BTCUSDT', RetainReasonEnum.FOREIGN_ADOPTED);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.RECONCILING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.TAKE_PROFIT,
            }),
        );

        const releasedReasons = releaseSpy.mock.calls.map(([, reason]) => reason as RetainReasonEnum);
        expect(releasedReasons).toContain(RetainReasonEnum.OPEN_POSITION);
        expect(releasedReasons).toContain(RetainReasonEnum.PENDING_RECONCILE);
        expect(releasedReasons).toContain(RetainReasonEnum.FOREIGN_ADOPTED);
        expect(retainer.isRetained('BTCUSDT')).toBe(false);
    });
});

describe('PositionLifecycleRetentionListener — RECONCILING bracket (ADR 0011 §5 PENDING_RECONCILE rows)', () => {
    it('retains PENDING_RECONCILE on transition into RECONCILING', () => {
        const { listener, retainSpy, retainer } = buildHarness();

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.OPEN, toState: PositionStateEnum.RECONCILING }));

        expect(retainSpy).toHaveBeenCalledWith('BTCUSDT', RetainReasonEnum.PENDING_RECONCILE);
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.PENDING_RECONCILE)).toBe(true);
    });

    it('releases PENDING_RECONCILE when leaving RECONCILING to a non-CLOSED state', () => {
        const { listener, retainer } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.PENDING_RECONCILE);

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.RECONCILING, toState: PositionStateEnum.OPEN }));

        // PENDING_RECONCILE released; OPEN_POSITION (toState=OPEN) retained instead.
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.PENDING_RECONCILE)).toBe(false);
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
    });
});

describe('PositionLifecycleRetentionListener — FOREIGN_ADOPTED bracket (ADR 0011 §5 FOREIGN_ADOPTED rows)', () => {
    it('retains FOREIGN_ADOPTED on transition into MANUAL_ADOPTED_UNMANAGED', () => {
        const { listener, retainSpy } = buildHarness();

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.RECONCILING, toState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED }));

        expect(retainSpy).toHaveBeenCalledWith('BTCUSDT', RetainReasonEnum.FOREIGN_ADOPTED);
    });

    it('releases FOREIGN_ADOPTED when leaving MANUAL_ADOPTED_UNMANAGED to OPEN (operator ack path)', () => {
        const { listener, retainer } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.FOREIGN_ADOPTED);

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, toState: PositionStateEnum.OPEN }));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.FOREIGN_ADOPTED)).toBe(false);
    });

    it('releases FOREIGN_ADOPTED when leaving MANUAL_ADOPTED_UNMANAGED to CLOSING (operator flatten path)', () => {
        const { listener, retainer } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.FOREIGN_ADOPTED);

        listener.onStateTransitioned(buildEvent({ fromState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, toState: PositionStateEnum.CLOSING }));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.FOREIGN_ADOPTED)).toBe(false);
    });
});

describe('PositionLifecycleRetentionListener — cooldown wiring (ADR 0011 §5 COOLDOWN_ACTIVE rows)', () => {
    it('retains COOLDOWN_ACTIVE on CLOSED with negative realized PnL', () => {
        const { listener, retainer, retainSpy } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.CLOSING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.STOP_LOSS,
                realizedPnl: '-12.5',
            }),
        );

        expect(retainSpy).toHaveBeenCalledWith('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        // Symbol stays retained even after OPEN_POSITION release because COOLDOWN_ACTIVE
        // still holds — the §5 promise: dropped from retainer only when last reason releases.
        expect(retainer.isRetained('BTCUSDT')).toBe(true);
        expect(retainer.getReasonsFor('BTCUSDT')).toEqual(new Set([RetainReasonEnum.COOLDOWN_ACTIVE]));
    });

    it('does NOT retain COOLDOWN_ACTIVE on CLOSED with positive realized PnL (a win does not arm cooldown)', () => {
        // W4b: predicate is now exit-reason aware. Use SIGNAL (a non-always-arming exit
        // reason that consults PnL) to assert the positive-PnL no-arm branch.
        const { listener, retainer, retainSpy } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.CLOSING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.SIGNAL,
                realizedPnl: '12.5',
            }),
        );

        const cooldownRetains = retainSpy.mock.calls.filter(([, reason]) => reason === RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(cooldownRetains).toHaveLength(0);
        expect(retainer.isRetained('BTCUSDT')).toBe(false);
    });

    it('does NOT retain COOLDOWN_ACTIVE on CLOSED with null realized PnL (reconciled_missing path)', () => {
        // RECONCILED_MISSING is the bot-didn't-see-fills exit reason — narrowed predicate
        // never arms cooldown on it (PnL is unknown).
        const { listener, retainer, retainSpy } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.RECONCILING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.RECONCILED_MISSING,
                realizedPnl: null,
            }),
        );

        const cooldownRetains = retainSpy.mock.calls.filter(([, reason]) => reason === RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(cooldownRetains).toHaveLength(0);
    });

    // ADR 0011 §5 row 8 "Cooldown expires → release(COOLDOWN_ACTIVE)" requires an
    // expiry signal that does not exist in M4 today (cooldown is duration-derivative
    // in RiskGateService.isCooldownActive). W4 wires a scheduler / event. Surfacing
    // here as a TODO so the gap is visible in the regression bar.
    it.todo('W4 follow-up: RiskGate emits cooldown-expired event and the listener releases COOLDOWN_ACTIVE on cooldownAfterLossMs elapsed');
});

describe('PositionLifecycleRetentionListener — R1.3.4 payload-driven routing (no DB re-read)', () => {
    // The fix replaces a post-transition `positionRepository.findById` round-trip
    // with the event payload's freshly-stamped symbol/exitReason/realizedPnl.
    // These tests prove that:
    //   1. The constructor no longer requires a PositionRepository injection
    //      (asserted by buildHarness — passes only `retainer`).
    //   2. Routing follows the payload alone — a "stale" row scenario where the
    //      DB has different state than the event still routes correctly because
    //      the listener does not consult the DB. The payload IS the source of
    //      truth for this listener.
    it('routes COOLDOWN_ACTIVE retain from payload realizedPnl + exitReason — no DB lookup is needed or attempted', () => {
        const { listener, retainer, retainSpy } = buildHarness();
        retainer.retain('ETHUSDT', RetainReasonEnum.OPEN_POSITION);

        // The payload's symbol drives the retainer key; a stale DB row could
        // carry a different symbol entirely (e.g. an in-flight rename window)
        // and the listener would not see it.
        listener.onStateTransitioned(
            buildEvent({
                symbol: 'ETHUSDT',
                positionId: 999,
                fromState: PositionStateEnum.CLOSING,
                toState: PositionStateEnum.CLOSED,
                exitReason: ExitReasonEnum.STOP_LOSS,
                realizedPnl: '-42.00',
            }),
        );

        // Cooldown armed on the PAYLOAD-supplied symbol, not on whatever the
        // row-table currently shows.
        expect(retainSpy).toHaveBeenCalledWith('ETHUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(retainer.getReasonsFor('ETHUSDT')).toEqual(new Set([RetainReasonEnum.COOLDOWN_ACTIVE]));
    });

    it('treats an unparsable realizedPnl as non-loss (defensive: malformed payload does not arm cooldown)', () => {
        const { listener, retainer, retainSpy } = buildHarness();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        listener.onStateTransitioned(
            buildEvent({
                fromState: PositionStateEnum.CLOSING,
                toState: PositionStateEnum.CLOSED,
                // SIGNAL consults PnL — but the value is garbage, so cooldown
                // must NOT arm (we never silently treat unknown PnL as a loss).
                exitReason: ExitReasonEnum.SIGNAL,
                realizedPnl: 'not-a-number',
            }),
        );

        const cooldownRetains = retainSpy.mock.calls.filter(([, reason]) => reason === RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(cooldownRetains).toHaveLength(0);
        expect(retainer.isRetained('BTCUSDT')).toBe(false);
    });
});

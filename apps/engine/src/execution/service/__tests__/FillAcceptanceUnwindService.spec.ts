/**
 * FillAcceptanceUnwindService — M38 D2 synthetic-close unit tests (ADR 0045 §6)
 *
 * Surfaces under test:
 *
 *   PC1 — Happy path: tryAcquire returns true → intent built → gate approves →
 *          ORDER_INTENT_APPROVED_EVENT emitted with FLATTEN intent
 *   PC2 — Gate reject: tryAcquire succeeds but gate rejects → closeCoordinator.release()
 *          called, no event emitted, method returns (no rethrow)
 *   PC3 — tryAcquire returns false (close already in flight) → method returns immediately,
 *          no gate call, no event
 *   PC4 — Throw inside try block → closeCoordinator.release() called, error swallowed
 *          (method does not rethrow)
 *   PC5 — FLATTEN intent fields: intentAction=FLATTEN, proposedExit has
 *          tpRebaseEligible=false, atrDistance=null
 *   PC6 — reservationId in approved event is the gate's reservationId (null for de-risking)
 *   PC7 — onOrderIntentExpired: halted/dry_run expiry of our synthetic-close eventId →
 *          release the held slot; other reasons / other prefixes → no release
 */

import { ExitReasonEnum, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, RiskOutcomeEnum, StopTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { ORDER_INTENT_APPROVED_EVENT } from '../../../common/const';
import { ORDER_INTENT_EXPIRED_REASON_DRY_RUN, ORDER_INTENT_EXPIRED_REASON_HALTED, SYNTHETIC_CLOSE_EVENT_ID_PREFIX } from '../../const';
import { FillAcceptanceUnwindService } from '../FillAcceptanceUnwindService';

// ─── fixture helpers ──────────────────────────────────────────────────────────

function buildPositionRow(overrides: Partial<any> = {}) {
    return {
        id: 77,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        qty: new Money('0.02'),
        entryPrice: new Money('50000'),
        entryNotional: new Money('1000'),
        leverage: new Money('2'),
        strategyVersionId: 2,
        flowTypeAtEntry: 'trend_initiation',
        correlationMode: 'idiosyncratic',
        coinTier: 'tier_1',
        ...overrides,
    } as any;
}

function buildRequest(overrides: Partial<any> = {}) {
    return {
        positionRow: buildPositionRow(),
        side: PositionSideEnum.LONG,
        markPrice: new Money('50000'),
        exitReason: ExitReasonEnum.FORCE_CLOSE,
        slot: PositionSlotEnum.A,
        strategyVersionId: 2,
        ...overrides,
    };
}

function buildApprovedGateDecision(reservationId: string | null = null) {
    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: null,
        clampedExit: null,
        reservationId,
        haltReasonDetail: null,
    };
}

function buildRejectedGateDecision() {
    return {
        outcome: RiskOutcomeEnum.REJECTED,
        rejectReason: 'max_positions',
        approvedSlot: null,
        approvedSizing: null,
        clampedExit: null,
        reservationId: null,
        haltReasonDetail: null,
    };
}

function buildService(
    overrides: {
        closeCoordinator?: any;
        riskGate?: any;
        events?: any;
    } = {},
): FillAcceptanceUnwindService {
    const {
        closeCoordinator = {
            tryAcquire: jest.fn().mockReturnValue(true),
            release: jest.fn(),
            isHeld: jest.fn().mockReturnValue(true),
        },
        riskGate = {
            evaluate: jest.fn().mockResolvedValue(buildApprovedGateDecision(null)),
        },
        events = { emit: jest.fn() },
    } = overrides;

    return new FillAcceptanceUnwindService(closeCoordinator, riskGate, events);
}

// ─── PC1: Happy path — event emitted ─────────────────────────────────────────

describe('FillAcceptanceUnwindService — PC1: tryAcquire succeeds + gate approves → ORDER_INTENT_APPROVED_EVENT emitted', () => {
    it('emits ORDER_INTENT_APPROVED_EVENT when slot is acquired and gate approves', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        await service.emitSyntheticClose(buildRequest());

        expect(emitSpy).toHaveBeenCalledTimes(1);
        const [eventName] = emitSpy.mock.calls[0];
        expect(eventName).toBe(ORDER_INTENT_APPROVED_EVENT);
    });

    it('approved event payload has intent.intentAction = FLATTEN', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        await service.emitSyntheticClose(buildRequest());

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.intent.intentAction).toBe(OrderIntentActionEnum.FLATTEN);
    });

    it('approved event carries the gate reservationId (null for de-risking approvals)', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            events: { emit: emitSpy },
            riskGate: {
                evaluate: jest.fn().mockResolvedValue(buildApprovedGateDecision(null)),
            },
        });

        await service.emitSyntheticClose(buildRequest());

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.reservationId).toBeNull();
    });
});

// ─── PC2: Gate reject → release called, no event ─────────────────────────────

describe('FillAcceptanceUnwindService — PC2: gate rejects → closeCoordinator.release() called, no event emitted', () => {
    it('release is called on the position id when gate rejects', async () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn().mockReturnValue(true),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
            riskGate: {
                evaluate: jest.fn().mockResolvedValue(buildRejectedGateDecision()),
            },
        });

        await service.emitSyntheticClose(buildRequest({ positionRow: buildPositionRow({ id: 99 }) }));

        expect(releaseSpy).toHaveBeenCalledWith(99);
    });

    it('no event is emitted when gate rejects', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            events: { emit: emitSpy },
            riskGate: {
                evaluate: jest.fn().mockResolvedValue(buildRejectedGateDecision()),
            },
        });

        await service.emitSyntheticClose(buildRequest());

        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('method returns normally (does not throw) when gate rejects', async () => {
        const service = buildService({
            riskGate: {
                evaluate: jest.fn().mockResolvedValue(buildRejectedGateDecision()),
            },
        });

        await expect(service.emitSyntheticClose(buildRequest())).resolves.toBeUndefined();
    });
});

// ─── PC3: tryAcquire = false (close already in flight) ───────────────────────

describe('FillAcceptanceUnwindService — PC3: tryAcquire=false → returns immediately, no gate call, no event', () => {
    it('gate is NOT called when tryAcquire returns false', async () => {
        const gateSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn().mockReturnValue(false),
                release: jest.fn(),
                isHeld: jest.fn().mockReturnValue(true),
            },
            riskGate: { evaluate: gateSpy },
        });

        await service.emitSyntheticClose(buildRequest());

        expect(gateSpy).not.toHaveBeenCalled();
    });

    it('no event is emitted when tryAcquire returns false', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn().mockReturnValue(false),
                release: jest.fn(),
                isHeld: jest.fn().mockReturnValue(true),
            },
            events: { emit: emitSpy },
        });

        await service.emitSyntheticClose(buildRequest());

        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('method returns normally (no throw) when slot is not acquired', async () => {
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn().mockReturnValue(false),
                release: jest.fn(),
                isHeld: jest.fn().mockReturnValue(true),
            },
        });

        await expect(service.emitSyntheticClose(buildRequest())).resolves.toBeUndefined();
    });
});

// ─── PC4: Throw inside try block → release called, no rethrow ────────────────

describe('FillAcceptanceUnwindService — PC4: throw inside try block → release called, error NOT rethrown', () => {
    it('release is called on throw inside the try block', async () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn().mockReturnValue(true),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
            riskGate: {
                evaluate: jest.fn().mockRejectedValue(new Error('gate internal error')),
            },
        });

        await service.emitSyntheticClose(buildRequest({ positionRow: buildPositionRow({ id: 55 }) }));

        expect(releaseSpy).toHaveBeenCalledWith(55);
    });

    it('method does NOT rethrow when gate throws (slot-leak safety)', async () => {
        const service = buildService({
            riskGate: {
                evaluate: jest.fn().mockRejectedValue(new Error('unexpected gate crash')),
            },
        });

        await expect(service.emitSyntheticClose(buildRequest())).resolves.toBeUndefined();
    });

    it('no event is emitted when a throw occurs inside the try block', async () => {
        const emitSpy = jest.fn();
        const service = buildService({
            events: { emit: emitSpy },
            riskGate: {
                evaluate: jest.fn().mockRejectedValue(new Error('gate error')),
            },
        });

        await service.emitSyntheticClose(buildRequest());

        expect(emitSpy).not.toHaveBeenCalled();
    });
});

// ─── PC5: FLATTEN intent fields — tpRebaseEligible=false, atrDistance=null ───

describe('FillAcceptanceUnwindService — PC5: FLATTEN intent has tpRebaseEligible=false and atrDistance=null', () => {
    it('the FLATTEN intent proposedExit carries tpRebaseEligible=false', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        await service.emitSyntheticClose(buildRequest());

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.intent.proposedExit.tpRebaseEligible).toBe(false);
    });

    it('the FLATTEN intent proposedExit carries atrDistance=null', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        await service.emitSyntheticClose(buildRequest());

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.intent.proposedExit.atrDistance).toBeNull();
    });

    it('the FLATTEN intent proposedExit stopType is ATR (synthetic de-risk close)', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        await service.emitSyntheticClose(buildRequest());

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.intent.proposedExit.stopType).toBe(StopTypeEnum.ATR);
    });

    it('the FLATTEN intent is on the OPPOSITE side of the position (close direction)', async () => {
        const emitSpy = jest.fn();
        const service = buildService({ events: { emit: emitSpy } });

        // LONG position → FLATTEN must be SHORT (to close)
        await service.emitSyntheticClose(
            buildRequest({
                positionRow: buildPositionRow({ side: PositionSideEnum.LONG }),
                side: PositionSideEnum.LONG,
            }),
        );

        const [, approvedEvent] = emitSpy.mock.calls[0];
        expect(approvedEvent.intent.tradeSide).toBe(PositionSideEnum.SHORT);
    });
});

// ─── PC6: Multiple calls are independent (no shared mutable state) ────────────

describe('FillAcceptanceUnwindService — PC6: consecutive calls for different positions are independent', () => {
    it('two consecutive emitSyntheticClose calls for different position IDs each acquire and release independently', async () => {
        const acquireSpy = jest.fn().mockReturnValue(true);
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: acquireSpy,
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
            // Second call rejects to verify the release path
            riskGate: {
                evaluate: jest.fn().mockResolvedValueOnce(buildApprovedGateDecision(null)).mockResolvedValueOnce(buildRejectedGateDecision()),
            },
        });

        await service.emitSyntheticClose(buildRequest({ positionRow: buildPositionRow({ id: 10 }), side: PositionSideEnum.LONG }));
        await service.emitSyntheticClose(buildRequest({ positionRow: buildPositionRow({ id: 20 }), side: PositionSideEnum.SHORT, slot: PositionSlotEnum.B }));

        expect(acquireSpy).toHaveBeenCalledTimes(2);
        expect(acquireSpy).toHaveBeenNthCalledWith(1, 10);
        expect(acquireSpy).toHaveBeenNthCalledWith(2, 20);
        // Second call had gate-reject → release was called for id=20
        expect(releaseSpy).toHaveBeenCalledWith(20);
        // First call was approved → release NOT called for id=10
        expect(releaseSpy).not.toHaveBeenCalledWith(10);
    });
});

// ─── PC7: onOrderIntentExpired — slot-leak guard on FLATTEN expiry ────────────

describe('FillAcceptanceUnwindService — PC7: onOrderIntentExpired releases the held slot on halted/dry_run expiry of our eventId', () => {
    it('releases the held slot when a synthetic-close intent expires (halted)', () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn(),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
        });

        service.onOrderIntentExpired({
            eventId: `${SYNTHETIC_CLOSE_EVENT_ID_PREFIX}123-force_close`,
            reservationId: null,
            reason: ORDER_INTENT_EXPIRED_REASON_HALTED,
        });

        expect(releaseSpy).toHaveBeenCalledWith(123);
    });

    it('releases the held slot when a synthetic-close intent expires (dry_run)', () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn(),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
        });

        service.onOrderIntentExpired({
            eventId: `${SYNTHETIC_CLOSE_EVENT_ID_PREFIX}45-force_close`,
            reservationId: null,
            reason: ORDER_INTENT_EXPIRED_REASON_DRY_RUN,
        });

        expect(releaseSpy).toHaveBeenCalledWith(45);
    });

    it('does NOT release on a non-halt/non-dry_run expiry reason', () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn(),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
        });

        service.onOrderIntentExpired({
            eventId: `${SYNTHETIC_CLOSE_EVENT_ID_PREFIX}123-force_close`,
            reservationId: null,
            reason: 'timeout',
        });

        expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('does NOT release when the eventId is another producer (different prefix)', () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn(),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(true),
            },
        });

        service.onOrderIntentExpired({
            eventId: 'time-stop-enforcer-123-time_stop',
            reservationId: null,
            reason: ORDER_INTENT_EXPIRED_REASON_HALTED,
        });

        expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('does NOT release when the slot is not held by us', () => {
        const releaseSpy = jest.fn();
        const service = buildService({
            closeCoordinator: {
                tryAcquire: jest.fn(),
                release: releaseSpy,
                isHeld: jest.fn().mockReturnValue(false),
            },
        });

        service.onOrderIntentExpired({
            eventId: `${SYNTHETIC_CLOSE_EVENT_ID_PREFIX}123-force_close`,
            reservationId: null,
            reason: ORDER_INTENT_EXPIRED_REASON_HALTED,
        });

        expect(releaseSpy).not.toHaveBeenCalled();
    });
});

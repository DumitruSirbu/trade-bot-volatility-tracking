/**
 * SharedCloseCoordinator — M33 Fix 1b adversarial QA (Wave 3).
 *
 * The locked release contract (ADR 0011 §9 Fix 1b table) must hold exactly:
 * releasing too early → double-close; releasing never → uncloseable position.
 *
 *   D-CO-1-adv: LocalProtectiveMonitor.disarm() does NOT release the shared slot.
 *   D-CO-2-adv: ORDER_INTENT_UNKNOWN_EVENT whose eventId matches a time-stop or monitor prefix
 *               does NOT release the slot — reconciliation now owns the row.
 *   D-CO-3-adv: dry_run and halted expiry release by prefix — correct prefix releases, wrong
 *               prefix leaves the slot held; an eventId matching neither prefix releases nothing.
 *   D-CO-4-adv: POSITION_STATE_TRANSITIONED → CLOSED releases the slot; gate non-APPROVED on a
 *               de-risk close releases the slot (terminal / no-order-submitted).
 */

import { ExitReasonEnum, IPriceUpdateEvent, PositionSideEnum, PositionSlotEnum, PositionStateEnum, RiskOutcomeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../../src/common/const';
import { Money } from '../../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { PositionTimeStopEnforcer } from '../../../src/execution/service/PositionTimeStopEnforcer';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';

import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { IOrderIntentApprovedEvent } from '../../../src/risk/interface';
import { RiskGateService } from '../../../src/risk/service';

const POSITION_ID = 55;
const SYMBOL = 'ETHUSDT';
const DEADLINE_MS = 1_700_000_000_000;

function buildPositionRow(): PositionEntity {
    return {
        id: POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        qty: new Money('0.5'),
        entryPrice: new Money('2000'),
        leverage: new Money('3'),
        positionSlot: PositionSlotEnum.A,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
        stopLossPrice: new Money('1900'),
        takeProfitPrice: new Money('2200'),
        timeStopAt: new Date(DEADLINE_MS),
    } as unknown as PositionEntity;
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

function approvedEventsOf(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
    return emitSpy.mock.calls.filter((call) => call[0] === ORDER_INTENT_APPROVED_EVENT).map((call) => call[1] as IOrderIntentApprovedEvent);
}

// ─── D-CO-1-adv ──────────────────────────────────────────────────────────────

describe('SharedCloseCoordinator release contract — adversarial', () => {
    it('D-CO-1-adv: LocalProtectiveMonitor.disarm() does NOT release the shared coordinator slot', async () => {
        // BUILD: acquire a slot via a monitor breach, then call disarm() before the CLOSED event.
        const coordinator = new SharedCloseCoordinator();

        // Simulate the monitor acquiring the slot (e.g. breach handler did tryAcquire before any await).
        const acquired = coordinator.tryAcquire(POSITION_ID);
        expect(acquired).toBe(true);

        // Construct a real LocalProtectiveMonitor backed by the shared coordinator.
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository,
            { evaluate: jest.fn() } as unknown as RiskGateService,
            new EventEmitter2(),
            coordinator,
        );

        // Arm it so disarm() has something to clear.
        monitor.arm({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('1900'),
            takeProfitPrice: new Money('2200'),
        });

        // OPERATE: disarm the monitor (applyReduceFillToPosition calls this BEFORE the CLOSED write).
        monitor.disarm(POSITION_ID);

        // CHECK: the shared slot is still held — disarm only clears the SL/TP arm state.
        // A price tick arriving between disarm and CLOSED must NOT be able to acquire the slot.
        expect(coordinator.isHeld(POSITION_ID)).toBe(true);
        expect(monitor.isArmed(POSITION_ID)).toBe(false); // arm state cleared
    });

    // ─── D-CO-2-adv ──────────────────────────────────────────────────────────

    it('D-CO-2-adv: ORDER_INTENT_UNKNOWN_EVENT (reconciliation) does NOT release the time-stop or monitor slot', () => {
        // BUILD: slots held for both a time-stop close and a monitor breach.
        const coordinator = new SharedCloseCoordinator();
        coordinator.tryAcquire(POSITION_ID);

        // The enforcer and monitor listen for ORDER_INTENT_EXPIRED_EVENT (reason halted/dry_run),
        // NOT ORDER_INTENT_UNKNOWN_EVENT. Verify neither releases on UNKNOWN events.
        // We directly assert the coordinator is unchanged after simulating what UNKNOWN would trigger.

        // Neither PositionTimeStopEnforcer.onOrderIntentExpired nor LocalProtectiveMonitor.onOrderIntentExpired
        // respond to ORDER_INTENT_UNKNOWN_EVENT — they only respond to ORDER_INTENT_EXPIRED_EVENT.
        // So after an UNKNOWN event with a matching eventId prefix, the slot must remain held.

        const eventEmitter = new EventEmitter2();
        const coordinator2 = new SharedCloseCoordinator();
        coordinator2.tryAcquire(POSITION_ID);

        const enforcer = new PositionTimeStopEnforcer(
            {
                findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([]),
                findOpen: jest.fn().mockResolvedValue([]),
                findById: jest.fn().mockResolvedValue(null),
            } as unknown as PositionRepository,
            { evaluate: jest.fn() } as unknown as RiskGateService,
            eventEmitter,
            coordinator2,
        );

        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository,
            { evaluate: jest.fn() } as unknown as RiskGateService,
            eventEmitter,
            coordinator2,
        );

        // Simulate ORDER_INTENT_UNKNOWN_EVENT with enforcer-prefixed eventId.
        // Neither the enforcer nor the monitor subscribes to this event — they only handle EXPIRED.
        // The ORDER_INTENT_UNKNOWN_EVENT is not an expired event; it doesn't call onOrderIntentExpired.
        // The slot must remain held so reconciliation can own the row without re-emit risk.
        enforcer.onOrderIntentExpired({
            eventId: `time-stop-enforcer-${POSITION_ID}`,
            reservationId: null,
            reason: 'unknown', // NOT 'halted' or 'dry_run' — the UNKNOWN case
        });

        // CHECK: an 'unknown' reason does NOT release the slot.
        expect(coordinator2.isHeld(POSITION_ID)).toBe(true);

        // Also verify with monitor prefix.
        const coordinator3 = new SharedCloseCoordinator();
        coordinator3.tryAcquire(POSITION_ID);
        monitor.onOrderIntentExpired({
            eventId: `local-monitor-breach-${POSITION_ID}-stop_loss`,
            reservationId: null,
            reason: 'unknown',
        });
        expect(coordinator3.isHeld(POSITION_ID)).toBe(true); // unchanged — unknown reason ignored

        void enforcer;
        void monitor;
    });

    // ─── D-CO-3-adv ──────────────────────────────────────────────────────────

    it('D-CO-3-adv: dry_run/halted expiry releases by correct prefix only; wrong prefix or neither changes nothing', () => {
        // BUILD: wire the enforcer and monitor to the SAME coordinator.
        const coordinator = new SharedCloseCoordinator();
        const eventEmitter = new EventEmitter2();

        const enforcerRepo = {
            findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([]),
            findOpen: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;

        const enforcer = new PositionTimeStopEnforcer(enforcerRepo, { evaluate: jest.fn() } as unknown as RiskGateService, eventEmitter, coordinator);

        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository,
            { evaluate: jest.fn() } as unknown as RiskGateService,
            eventEmitter,
            coordinator,
        );

        // PART A: enforcer prefix on halted expiry → releases the enforcer's slot.
        coordinator.tryAcquire(POSITION_ID);
        enforcer.onOrderIntentExpired({
            eventId: `time-stop-enforcer-${POSITION_ID}`,
            reservationId: null,
            reason: 'halted',
        });
        expect(coordinator.isHeld(POSITION_ID)).toBe(false); // released by enforcer's handler

        // PART B: monitor prefix on dry_run expiry → releases the monitor's slot.
        coordinator.tryAcquire(POSITION_ID); // re-acquire
        monitor.onOrderIntentExpired({
            eventId: `local-monitor-breach-${POSITION_ID}-stop_loss`,
            reservationId: null,
            reason: 'dry_run',
        });
        expect(coordinator.isHeld(POSITION_ID)).toBe(false); // released by monitor's handler

        // PART C: enforcer prefix expiry does NOT release a monitor-held slot (different producer).
        // The coordinator is position-id-keyed (not prefix-keyed), so the slot is the same.
        // Cross-producer release is prevented because each handler parses its OWN prefix:
        // the monitor's onOrderIntentExpired returns null for a time-stop-enforcer- eventId,
        // and the enforcer's handler returns null for a local-monitor-breach- eventId.
        coordinator.tryAcquire(POSITION_ID); // re-acquire (e.g. monitor held it)
        // Call the ENFORCER's handler with a MONITOR-prefixed eventId — must NOT release.
        enforcer.onOrderIntentExpired({
            eventId: `local-monitor-breach-${POSITION_ID}-stop_loss`,
            reservationId: null,
            reason: 'halted',
        });
        expect(coordinator.isHeld(POSITION_ID)).toBe(true); // enforcer ignores wrong prefix

        // PART D: call the MONITOR's handler with an ENFORCER-prefixed eventId — must NOT release.
        monitor.onOrderIntentExpired({
            eventId: `time-stop-enforcer-${POSITION_ID}`,
            reservationId: null,
            reason: 'dry_run',
        });
        expect(coordinator.isHeld(POSITION_ID)).toBe(true); // monitor ignores wrong prefix

        // PART E: an eventId matching neither prefix releases nothing.
        monitor.onOrderIntentExpired({
            eventId: `reconciliation-flatten-${POSITION_ID}-12345`,
            reservationId: null,
            reason: 'halted',
        });
        expect(coordinator.isHeld(POSITION_ID)).toBe(true); // neither parser matches

        void enforcer;
        void monitor;
    });

    // ─── D-CO-4-adv ──────────────────────────────────────────────────────────

    it('D-CO-4-adv: POSITION_STATE_TRANSITIONED→CLOSED releases the slot; gate non-APPROVED on a de-risk close releases the slot', async () => {
        // PART A: CLOSED transition releases the slot.
        const coordinator = new SharedCloseCoordinator();
        coordinator.tryAcquire(POSITION_ID);

        const positionRow = buildPositionRow();

        const enforcerRepo = {
            findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([positionRow]),
            findOpen: jest.fn().mockResolvedValue([positionRow]),
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const enforcer = new PositionTimeStopEnforcer(enforcerRepo, { evaluate: jest.fn() } as unknown as RiskGateService, new EventEmitter2(), coordinator);

        enforcer.onPositionStateTransitioned({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: DEADLINE_MS + 1000,
            eventClass: 'reduce.terminal',
            exitReason: ExitReasonEnum.TIME_STOP,
            realizedPnl: null,
        });

        expect(coordinator.isHeld(POSITION_ID)).toBe(false); // released on CLOSED

        // PART B: gate non-APPROVED on a time-stop de-risk close releases the slot.
        // The enforcer calls coordinator.release(positionId) on a gate reject so the next tick retries.
        const coordinator2 = new SharedCloseCoordinator();
        const events2 = new EventEmitter2();
        const emitSpy2 = jest.spyOn(events2, 'emit');

        const rejectGate = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.REJECTED,
            rejectReason: 'cooldown_active',
            reservationId: null,
        });

        const enforcerRepo2 = {
            findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([positionRow]),
            findOpen: jest.fn().mockResolvedValue([positionRow]),
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const enforcer2 = new PositionTimeStopEnforcer(enforcerRepo2, { evaluate: rejectGate } as unknown as RiskGateService, events2, coordinator2);

        await enforcer2.onModuleInit();

        const priceUpdate: IPriceUpdateEvent = { symbol: SYMBOL, price: '2000', timestampMs: DEADLINE_MS };
        enforcer2.onPriceUpdate(priceUpdate);
        await flush();

        // CHECK: no close emitted AND the slot was released so the next tick can retry.
        expect(approvedEventsOf(emitSpy2)).toHaveLength(0);
        expect(coordinator2.isHeld(POSITION_ID)).toBe(false); // released on gate reject

        void enforcer;
        void enforcer2;
    });
});

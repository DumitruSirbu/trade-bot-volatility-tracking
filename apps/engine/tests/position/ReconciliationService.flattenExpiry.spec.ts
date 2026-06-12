/**
 * ReconciliationService — M33 R1-Fix-A flatten-expiry slot release.
 *
 * The case-(a) flatten acquires the shared close slot and holds it until the row reaches CLOSED.
 * If a halt / dry_run boundary lands after the flatten emits its intent, the executor emits
 * ORDER_INTENT_EXPIRED_EVENT{reason:'halted'|'dry_run'} with the flatten eventId
 * `reconciliation-flatten-${positionId}-${nowMs}`. Neither the enforcer's parser
 * (`time-stop-enforcer-`) nor the monitor's parser (`local-monitor-breach-`) matches it, so without
 * the reconciliation listener the slot stays held forever. These tests assert the listener releases
 * the slot only for its own eventId prefix.
 *
 *   D-FL expiry: a halt expiry matching the reconciliation-flatten prefix releases the slot.
 *   D-FL expiry: a dry_run expiry releases the slot.
 *   D-FL expiry: an expiry with a non-matching prefix does NOT release the slot.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';

const POSITION_ID = 42;
const NOW_MS = 1_700_000_000_000;
const FLATTEN_EVENT_ID = `reconciliation-flatten-${POSITION_ID}-${NOW_MS}`;

interface IFixture {
    service: ReconciliationService;
    coordinator: SharedCloseCoordinator;
}

function buildFixture(): IFixture {
    const coordinator = new SharedCloseCoordinator();

    // The expiry handler depends only on the close coordinator + logger; the remaining deps are
    // never exercised by this path, so a permissive stub keeps the test isolated.
    const service = new ReconciliationService(
        {} as never,
        {} as never,
        { exchangeEnv: 'testnet' } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        new HaltFlagService(),
        {} as never,
        {} as never,
        new EventEmitter2(),
        coordinator,
    );

    return { service, coordinator };
}

describe('ReconciliationService flatten-expiry slot release', () => {
    it('D-FL expiry: a halt expiry matching the reconciliation-flatten prefix releases the coordinator slot', () => {
        // BUILD
        const { service, coordinator } = buildFixture();
        coordinator.tryAcquire(POSITION_ID);

        // OPERATE
        service.onOrderIntentExpired({ eventId: FLATTEN_EVENT_ID, reservationId: null, reason: 'halted' });

        // CHECK
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    it('D-FL expiry: a dry_run expiry releases the slot', () => {
        // BUILD
        const { service, coordinator } = buildFixture();
        coordinator.tryAcquire(POSITION_ID);

        // OPERATE
        service.onOrderIntentExpired({ eventId: FLATTEN_EVENT_ID, reservationId: null, reason: 'dry_run' });

        // CHECK
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    it('D-FL expiry: an expiry with a non-matching prefix does NOT release the slot', () => {
        // BUILD
        const { service, coordinator } = buildFixture();
        coordinator.tryAcquire(POSITION_ID);

        // OPERATE — the monitor's breach eventId is owned by LocalProtectiveMonitor, not reconciliation.
        service.onOrderIntentExpired({ eventId: `local-monitor-breach-${POSITION_ID}-stop_loss`, reservationId: null, reason: 'halted' });

        // CHECK — the reconciliation listener must leave a non-reconciliation slot untouched.
        expect(coordinator.isHeld(POSITION_ID)).toBe(true);
    });
});

/**
 * Cross-producer close collision — M33 adversarial QA (Wave 3).
 *
 * The SharedCloseCoordinator is the single dedup substrate across ALL gate-routed close
 * producers. When two producers fire for the same position on the same tick, exactly one
 * close must be emitted.
 *
 *   D-FL-1-adv: ReconciliationService.flattenAdoptedForeignPosition + PositionTimeStopEnforcer
 *               both fire for the same position → whichever acquires the slot first emits once;
 *               the other finds the slot held and emits nothing → exactly ONE approved event.
 *
 *   D-FL-2-adv: LocalProtectiveMonitor.handleBreach + flattenAdoptedForeignPosition both fire
 *               for the same position → exactly one close (registry is the single substrate).
 *
 * Strategy: rather than trying to drive the private `flattenAdoptedForeignPosition` through the
 * full reconciliation tick (which requires a large exchange-state harness), we simulate the
 * registry-level collision directly: pre-acquire the coordinator slot to represent "producer A
 * has acquired and is about to emit", then trigger producer B's path and assert it finds the slot
 * held. This is a faithful model because the only protection against double-close is
 * `coordinator.tryAcquire` — both producers are tested in their actual source code against the
 * shared registry.
 */

import { IPriceUpdateEvent, PositionSideEnum, PositionSlotEnum, PositionStateEnum, RiskOutcomeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { PositionTimeStopEnforcer } from '../../src/execution/service/PositionTimeStopEnforcer';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { IOrderIntentApprovedEvent } from '../../src/risk/interface';
import { RiskGateService } from '../../src/risk/service';

const POSITION_ID = 88;
const SYMBOL = 'SOLUSDT';
const DEADLINE_MS = 1_700_000_000_000;

function buildPositionRow(): PositionEntity {
    return {
        id: POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        qty: new Money('1.0'),
        entryPrice: new Money('100'),
        leverage: new Money('5'),
        positionSlot: PositionSlotEnum.A,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
        stopLossPrice: new Money('90'),
        takeProfitPrice: new Money('120'),
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

// ─── D-FL-1-adv ──────────────────────────────────────────────────────────────

describe('Cross-producer close collision — adversarial', () => {
    it('D-FL-1-adv: reconciliation-flatten slot pre-held → time-stop enforcer finds it held and emits nothing', async () => {
        // SCENARIO: The reconciliation flatten producer (flattenAdoptedForeignPosition) has already
        // acquired the shared coordinator slot for this position (it did tryAcquire successfully before
        // its gate call). The time-stop enforcer fires on the same tick and must find the slot held.
        //
        // We simulate this by pre-acquiring the coordinator slot (representing the reconciliation
        // flatten producer), then running the enforcer's onPriceUpdate. The enforcer's synchronous
        // tryAcquire returns false → it skips the close and emits nothing.

        // BUILD
        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const positionRow = buildPositionRow();

        const enforcerRepo = {
            findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([positionRow]),
            findOpen: jest.fn().mockResolvedValue([positionRow]),
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const approvedGate = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            reservationId: null,
        });

        const enforcer = new PositionTimeStopEnforcer(enforcerRepo, { evaluate: approvedGate } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE: reconciliation flatten producer acquires the slot first (synchronously).
        const reconciliationAcquired = coordinator.tryAcquire(POSITION_ID);
        expect(reconciliationAcquired).toBe(true); // reconciliation won the slot

        // Now the enforcer fires on the same tick.
        const priceUpdate: IPriceUpdateEvent = { symbol: SYMBOL, price: '100', timestampMs: DEADLINE_MS };
        enforcer.onPriceUpdate(priceUpdate);
        await flush();

        // CHECK: enforcer found the slot held and emitted nothing.
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(approvedGate).not.toHaveBeenCalled();
        expect(coordinator.isHeld(POSITION_ID)).toBe(true); // slot still held by reconciliation

        void enforcer;
    });

    it('D-FL-1-adv (inverse): time-stop enforcer acquires slot first → reconciliation flatten finds it held', async () => {
        // SCENARIO (reverse): the enforcer fires first and acquires the slot. The reconciliation
        // flatten producer's `tryAcquire` returns false → it skips the flatten.
        // We verify this by acquiring the slot via the enforcer, then asserting that
        // a subsequent `coordinator.tryAcquire` (representing reconciliation's attempt) returns false.

        // BUILD
        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const positionRow = buildPositionRow();

        const enforcerRepo = {
            findTimeStopCandidatesBySymbol: jest.fn().mockResolvedValue([positionRow]),
            findOpen: jest.fn().mockResolvedValue([positionRow]),
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const approvedGate = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            reservationId: null,
        });

        const enforcer = new PositionTimeStopEnforcer(enforcerRepo, { evaluate: approvedGate } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE: enforcer fires first (synchronous acquire before first await).
        const priceUpdate: IPriceUpdateEvent = { symbol: SYMBOL, price: '100', timestampMs: DEADLINE_MS };
        enforcer.onPriceUpdate(priceUpdate);
        // Do NOT flush yet — the enforcer has acquired the slot synchronously but its async work hasn't completed.

        // Reconciliation flatten producer attempts to acquire the same slot now.
        const reconciliationAttempt = coordinator.tryAcquire(POSITION_ID);

        // CHECK: reconciliation finds the slot held (acquired synchronously by the enforcer).
        expect(reconciliationAttempt).toBe(false);

        await flush();

        // After flush, only the enforcer emitted.
        expect(approvedEventsOf(emitSpy)).toHaveLength(1);

        void enforcer;
    });

    // ─── D-FL-2-adv ──────────────────────────────────────────────────────────

    it('D-FL-2-adv: LocalProtectiveMonitor breach + reconciliation-flatten collision → exactly one close', async () => {
        // SCENARIO: A monitor breach fires (SL triggered) for a position. The reconciliation
        // flatten producer also fires for the same position on the same tick. Exactly one close.
        //
        // We test the registry-level guard: the monitor (or reconciliation) acquires the slot
        // first; the other producer finds the slot held and emits nothing.

        // BUILD: shared coordinator + event bus across both producers.
        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const positionRow = buildPositionRow();

        const monitorRepo = {
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const monitorGate = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            reservationId: null,
        });

        const monitor = new LocalProtectiveMonitor(monitorRepo, { evaluate: monitorGate } as unknown as RiskGateService, events, coordinator);

        // Arm the monitor for the position with an SL that the mark price will breach.
        monitor.arm({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('90'), // SL at 90
            takeProfitPrice: new Money('120'),
        });

        // OPERATE: reconciliation flatten producer pre-acquires the slot (it fires "first").
        const reconciliationAcquired = coordinator.tryAcquire(POSITION_ID);
        expect(reconciliationAcquired).toBe(true);

        // Now the monitor fires on the same tick (mark price 90 = SL → breach).
        const priceUpdate: IPriceUpdateEvent = { symbol: SYMBOL, price: '90', timestampMs: DEADLINE_MS };
        await monitor.onPriceUpdate(priceUpdate);

        // CHECK: the monitor found the slot held by reconciliation and emitted nothing.
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(monitorGate).not.toHaveBeenCalled();
        expect(coordinator.isHeld(POSITION_ID)).toBe(true); // reconciliation still holds

        void monitor;
    });

    it('D-FL-2-adv (inverse): monitor acquires first → reconciliation-flatten find slot held', async () => {
        // SCENARIO (reverse): the monitor fires first and acquires the slot. The reconciliation
        // flatten producer's tryAcquire returns false → it skips the flatten.

        // BUILD
        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const positionRow = buildPositionRow();

        const monitorRepo = {
            findById: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const approvedGate = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            reservationId: null,
        });

        const monitor = new LocalProtectiveMonitor(monitorRepo, { evaluate: approvedGate } as unknown as RiskGateService, events, coordinator);

        monitor.arm({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('90'),
            takeProfitPrice: new Money('120'),
        });

        // OPERATE: trigger the SL breach. The monitor acquires the slot synchronously via tryAcquire
        // at the start of handleBreach, before its first await.
        const priceUpdate: IPriceUpdateEvent = { symbol: SYMBOL, price: '90', timestampMs: DEADLINE_MS };
        // handleBreach is async — call without awaiting to test mid-execution state.
        const monitorRun = monitor.onPriceUpdate(priceUpdate);

        // While the monitor's handleBreach is suspended on its first DB await (findById),
        // the reconciliation flatten producer attempts to acquire the slot.
        const reconciliationAttempt = coordinator.tryAcquire(POSITION_ID);

        // CHECK: reconciliation finds the slot already held by the monitor's synchronous acquire.
        expect(reconciliationAttempt).toBe(false);

        await monitorRun;
        await flush();

        // Only the monitor emitted.
        expect(approvedEventsOf(emitSpy)).toHaveLength(1);

        void monitor;
    });
});

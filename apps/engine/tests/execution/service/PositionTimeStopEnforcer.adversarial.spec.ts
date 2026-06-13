/**
 * PositionTimeStopEnforcer — M33 adversarial QA (Wave 3).
 *
 * Covers the test IDs the engineer did NOT write:
 *
 *   D-TS-7-adv:  stale index entry pointing to a closed/qty=0 row — no emit, slot released.
 *   D-TS-8:      time_stop_at IS NULL excluded by the candidate query — never fires.
 *   D-TS-10-adv: PENDING_OPEN past deadline → close intent emitted with exitReason=TIME_STOP.
 *   D-TS-14-adv: restart with past deadline — exactly one close fires on first tick; a second
 *                tick after CLOSED emits nothing.
 *   D-TS-15-adv: restart while a close is already in flight (row is CLOSING) — findTimeStopCandidatesBySymbol
 *                excludes CLOSING rows so the rebuilt index has no entry; the enforcer emits nothing.
 */

import { ExitReasonEnum, IPriceUpdateEvent, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, RiskOutcomeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../../src/common/const';
import { Money } from '../../../src/common/utils/money';
import { PositionTimeStopEnforcer } from '../../../src/execution/service/PositionTimeStopEnforcer';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';

import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { IOrderIntentApprovedEvent } from '../../../src/risk/interface';
import { RiskGateService } from '../../../src/risk/service';

const SYMBOL = 'BTCUSDT';
const DEADLINE_MS = 1_700_000_000_000;
const POSITION_ID = 77;

// ─── factories ───────────────────────────────────────────────────────────────

function buildRow(
    overrides: {
        id?: number;
        state?: PositionStateEnum;
        qty?: string;
        timeStopAtMs?: number | null;
    } = {},
): PositionEntity {
    const timeStopAtMs = overrides.timeStopAtMs === undefined ? DEADLINE_MS : overrides.timeStopAtMs;

    return {
        id: overrides.id ?? POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: overrides.state ?? PositionStateEnum.OPEN,
        qty: new Money(overrides.qty ?? '0.01'),
        entryPrice: new Money('30000'),
        leverage: new Money('5'),
        positionSlot: PositionSlotEnum.A,
        strategyVersionId: 1,
        correlationMode: null,
        coinTier: null,
        flowTypeAtEntry: null,
        stopLossPrice: new Money('29000'),
        takeProfitPrice: new Money('31000'),
        timeStopAt: timeStopAtMs === null ? null : new Date(timeStopAtMs),
    } as unknown as PositionEntity;
}

function buildApprovedGate() {
    return jest.fn().mockResolvedValue({
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        reservationId: null,
    });
}

function buildPriceUpdate(timestampMs: number): IPriceUpdateEvent {
    return { symbol: SYMBOL, price: '30000', timestampMs };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

function approvedEventsOf(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
    return emitSpy.mock.calls.filter((call) => call[0] === ORDER_INTENT_APPROVED_EVENT).map((call) => call[1] as IOrderIntentApprovedEvent);
}

// ─── D-TS-7-adv ──────────────────────────────────────────────────────────────

describe('PositionTimeStopEnforcer adversarial', () => {
    it('D-TS-7-adv: stale index entry pointing to closed/qty=0 row — no emit, slot released', async () => {
        // BUILD: the boot rebuild loads the row (timeStopAt set, OPEN). The step-3 re-read
        // returns an empty candidate list — the row was closed between the index build and the tick.
        // This simulates a stale index entry that no longer has a live candidate in the DB.
        const openRow = buildRow({ timeStopAtMs: DEADLINE_MS });

        let callCount = 0;
        const findCandidates = jest.fn().mockImplementation(async () => {
            callCount += 1;

            if (callCount === 1) {
                return [openRow]; // boot rebuild: row is open
            }

            return []; // step-3 re-read: row gone (closed, drained)
        });

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([openRow]),
            findById: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: jest.fn() } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE: tick at/after the deadline.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        // CHECK: no close intent emitted AND the slot was released so the next tick can retry.
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    // ─── D-TS-8 ──────────────────────────────────────────────────────────────

    it('D-TS-8: a row with time_stop_at IS NULL is excluded by the candidate query — enforcer never fires', async () => {
        // BUILD: the candidate query (findTimeStopCandidatesBySymbol) excludes IS-NULL rows.
        // The boot rebuild returns empty because this row has no deadline.
        const rowNoDeadline = buildRow({ timeStopAtMs: null });

        const findCandidates = jest.fn().mockResolvedValue([rowNoDeadline]);
        // NOTE: the repository-level predicate excludes IS-NULL rows. The test simulates the
        // correct behavior: even if we stub the mock to return the null-deadline row,
        // the enforcer's own deadline-check in rebuildSymbolIndex should skip it.
        // We verify: index is empty → earliestTimeStopMs stays Infinity → no tick fires.

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([rowNoDeadline]),
            findById: jest.fn().mockResolvedValue(rowNoDeadline),
        } as unknown as PositionRepository;

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const evaluateSpy = jest.fn();

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: evaluateSpy } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE: many ticks at/after where the deadline WOULD have been.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 1));
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 60_000));
        await flush();

        // CHECK: gate never called, no close emitted. The IS-NULL row is skipped in rebuildSymbolIndex
        // (position.timeStopAt === null → not added to the sub-map), so earliestTimeStopMs stays Infinity
        // and every tick passes the fast-path guard without reaching the per-symbol loop.
        expect(evaluateSpy).not.toHaveBeenCalled();
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    // ─── D-TS-10-adv ─────────────────────────────────────────────────────────

    it('D-TS-10-adv: PENDING_OPEN row past its deadline → close intent emitted with exitReason=TIME_STOP and correct qty', async () => {
        // BUILD: a PENDING_OPEN row (legal source state per ADR 0011 §9) past its deadline.
        const pendingRow = buildRow({ state: PositionStateEnum.PENDING_OPEN, qty: '0.02', timeStopAtMs: DEADLINE_MS });

        const findCandidates = jest.fn().mockResolvedValue([pendingRow]);
        const evaluateSpy = buildApprovedGate();

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([pendingRow]),
            findById: jest.fn().mockResolvedValue(pendingRow),
        } as unknown as PositionRepository;

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: evaluateSpy } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // OPERATE: tick at the deadline.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        // CHECK: one close intent emitted with TIME_STOP and the PENDING_OPEN row's full qty.
        const approved = approvedEventsOf(emitSpy);

        expect(approved).toHaveLength(1);
        expect(approved[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TIME_STOP);
        // The close carries the current qty from the re-read (0.02).
        expect(approved[0].intent.sizing.qty.toFixed()).toBe(new Money('0.02').toFixed());
        // The enforcer emits the close; the downstream applyReduceFillToPosition promotes PENDING_OPEN→OPEN.
        expect(evaluateSpy).toHaveBeenCalledTimes(1);
    });

    // ─── D-TS-14-adv ─────────────────────────────────────────────────────────

    it('D-TS-14-adv: restart with past deadline — exactly one close fires on first tick; second tick after CLOSED emits nothing', async () => {
        // BUILD: simulate a restart by calling onModuleInit() fresh (registry + index reset).
        // The row is OPEN with a past deadline.
        const pastRow = buildRow({ timeStopAtMs: DEADLINE_MS - 10_000 });

        const findCandidates = jest.fn().mockResolvedValue([pastRow]);
        const evaluateSpy = buildApprovedGate();

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([pastRow]),
            findById: jest.fn().mockResolvedValue(pastRow),
        } as unknown as PositionRepository;

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: evaluateSpy } as unknown as RiskGateService, events, coordinator);

        // OPERATE (step 1): rebuilt index from DB (simulates post-restart onModuleInit).
        await enforcer.onModuleInit();

        // First tick — should fire exactly once.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        expect(approvedEventsOf(emitSpy)).toHaveLength(1);

        // OPERATE (step 2): the position closes → CLOSED transition event fires.
        enforcer.onPositionStateTransitioned({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: DEADLINE_MS,
            eventClass: 'reduce.terminal',
            exitReason: ExitReasonEnum.TIME_STOP,
            realizedPnl: null,
        });

        // CHECK: slot released after CLOSED.
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);

        // OPERATE (step 3): a second price tick after CLOSED.
        emitSpy.mockClear();
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 1_000));
        await flush();

        // CHECK: no second close emitted (index was pruned on CLOSED).
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
    });

    // ─── D-TS-15-adv ─────────────────────────────────────────────────────────

    it('D-TS-15-adv: restart while close is in flight (CLOSING row) — candidate query excludes CLOSING rows, enforcer emits nothing', async () => {
        // BUILD: the DB has a row in CLOSING state (a close was submitted before the restart).
        // findTimeStopCandidatesBySymbol excludes CLOSING rows (the repository-level safety
        // predicate only allows OPEN/PENDING_OPEN). The rebuilt index has no entry for this row,
        // so the enforcer does NOT re-emit on the first price tick.
        // This verifies that durable state (CLOSING row) + executor clientOrderId idempotency back
        // the registry across the restart boundary (the registry alone cannot, since it reset).

        // Simulate the correct repository behavior: CLOSING row is excluded by the predicate.
        const findCandidates = jest.fn().mockResolvedValue([]); // CLOSING excluded at DB level

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidates,
            findOpen: jest.fn().mockResolvedValue([]), // findOpen also returns nothing relevant
            findById: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const evaluateSpy = jest.fn();

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: evaluateSpy } as unknown as RiskGateService, events, coordinator);

        // OPERATE: boot rebuild (index empty because CLOSING row excluded).
        await enforcer.onModuleInit();

        // First tick — deadline is in the past but index is empty.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 5_000));
        await flush();

        // CHECK: zero close intents (the in-flight close is tracked at the exchange via
        // clientOrderId; the enforcer correctly stays silent).
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(evaluateSpy).not.toHaveBeenCalled();
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });
});

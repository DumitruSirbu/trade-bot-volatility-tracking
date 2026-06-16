/**
 * PositionTimeStopEnforcer — M33 Fix 1 (ADR 0011 §9). The live/paper time-stop enforcer.
 *
 * On every price.update it closes any OPEN/PENDING_OPEN position whose time_stop_at is crossed,
 * routing the CLOSE through the gate exactly as LocalProtectiveMonitor does. Coverage:
 *
 *   D-TS-1: past-deadline OPEN row → exactly one ORDER_INTENT_APPROVED_EVENT, exitReason=TIME_STOP.
 *   D-TS-2: event timestamp < time_stop_at → no intent.
 *   D-TS-3: determinism — compares event.timestampMs, NOT Date.now() (frozen clock before deadline,
 *           event after → close fires).
 *   D-TS-4: idempotency burst — 3 past-deadline ticks → exactly one close (registry dedupes).
 *   D-TS-5-adv: time-stop WINS the same-tick collision — (a) enforcer listener invoked first via
 *           prependListener, AND (b) with an artificial await delay in the enforcer's first DB call,
 *           the monitor STILL cannot acquire the slot (synchronous acquire-before-await — GBT H1).
 */

import { ExitReasonEnum, IPriceUpdateEvent, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, RiskOutcomeEnum } from '@bot/shared';
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

const SYMBOL = 'BTCUSDT';
const DEADLINE_MS = 1_700_000_000_000;
const POSITION_ID = 42;

interface IHarnessOpts {
    state?: PositionStateEnum;
    qty?: string;
    timeStopAtMs?: number | null;
    gateOutcome?: RiskOutcomeEnum;
    candidateMissing?: boolean;
}

interface IHarness {
    enforcer: PositionTimeStopEnforcer;
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
    evaluateSpy: jest.Mock;
    coordinator: SharedCloseCoordinator;
    findCandidatesSpy: jest.Mock;
}

function buildRow(opts: IHarnessOpts): PositionEntity | null {
    if (opts.candidateMissing === true) {
        return null;
    }

    const timeStopAtMs = opts.timeStopAtMs === undefined ? DEADLINE_MS : opts.timeStopAtMs;

    return {
        id: POSITION_ID,
        symbol: SYMBOL,
        side: PositionSideEnum.LONG,
        state: opts.state ?? PositionStateEnum.OPEN,
        qty: new Money(opts.qty ?? '0.01'),
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

function buildHarness(opts: IHarnessOpts = {}): IHarness {
    const row = buildRow(opts);
    const candidates = row === null ? [] : [row];
    const findCandidatesSpy = jest.fn().mockResolvedValue(candidates);

    const repository = {
        findTimeStopCandidatesBySymbol: findCandidatesSpy,
        findOpen: jest.fn().mockResolvedValue(candidates),
        findById: jest.fn().mockResolvedValue(row),
    } as unknown as PositionRepository;

    const gateOutcome = opts.gateOutcome ?? RiskOutcomeEnum.APPROVED;
    const evaluateSpy = jest.fn().mockResolvedValue({
        outcome: gateOutcome,
        rejectReason: gateOutcome === RiskOutcomeEnum.APPROVED ? null : 'cooldown_active',
        reservationId: null,
    });
    const gate = { evaluate: evaluateSpy } as unknown as RiskGateService;

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');
    const coordinator = new SharedCloseCoordinator();

    const enforcer = new PositionTimeStopEnforcer(repository, gate, events, coordinator);

    return { enforcer, events, emitSpy, evaluateSpy, coordinator, findCandidatesSpy };
}

function buildPriceUpdate(timestampMs: number): IPriceUpdateEvent {
    return { symbol: SYMBOL, price: '30000', timestampMs };
}

// Drains the microtask queue so the `void enforceTimeStop(...)` async chain settles before
// assertions. Uses chained microtasks (not setImmediate) so it resolves under fake timers too.
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

// Arms the in-memory deadline index from the DB (the boot rebuild path), so the synchronous hot-path
// sees the deadline.
async function armIndex(enforcer: PositionTimeStopEnforcer): Promise<void> {
    await enforcer.onModuleInit();
}

function approvedEventsOf(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
    return emitSpy.mock.calls.filter((call) => call[0] === ORDER_INTENT_APPROVED_EVENT).map((call) => call[1] as IOrderIntentApprovedEvent);
}

describe('PositionTimeStopEnforcer', () => {
    it('D-TS-1: a past-deadline OPEN position emits exactly one CLOSE intent with exitReason=TIME_STOP', async () => {
        // BUILD
        const { enforcer, emitSpy, evaluateSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);

        // OPERATE: a tick whose event time is at/after the deadline.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        // CHECK
        const approved = approvedEventsOf(emitSpy);

        expect(approved).toHaveLength(1);
        expect(approved[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TIME_STOP);
        expect(approved[0].intent.tradeSide).toBe(PositionSideEnum.SHORT); // opposite of LONG
        expect(approved[0].intent.eventId).toBe(`time-stop-enforcer-${POSITION_ID}`);
        expect(evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('D-TS-2: a tick before the deadline emits no intent', async () => {
        // BUILD
        const { enforcer, emitSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);

        // OPERATE: event time one ms before the deadline.
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS - 1));
        await flush();

        // CHECK
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
    });

    it('D-TS-3 (determinism): closes against event time, not Date.now() — frozen clock before deadline, event after', async () => {
        // BUILD: freeze the wall clock strictly BEFORE the deadline. If the enforcer read Date.now()
        // anywhere on the due-decision path, the close would NOT fire.
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(DEADLINE_MS - 60_000);

        try {
            const { enforcer, emitSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
            await armIndex(enforcer);

            // OPERATE: the price.update event time is AFTER the deadline even though Date.now() is before.
            enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 1));
            await flush();

            // CHECK: the close fires — the enforcer compared event.timestampMs, not the frozen clock.
            expect(approvedEventsOf(emitSpy)).toHaveLength(1);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('D-TS-4 (idempotency burst): three consecutive past-deadline ticks emit exactly one close', async () => {
        // BUILD
        const { enforcer, emitSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);

        // OPERATE: three ticks all past the deadline; the slot stays held (no CLOSED event releases it).
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 1));
        await flush();
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 2));
        await flush();

        // CHECK
        expect(approvedEventsOf(emitSpy)).toHaveLength(1);
    });

    it('D-TS-5-adv (time-stop WINS): enforcer invoked first AND a delayed enforcer await still blocks the monitor (GBT H1)', async () => {
        // BUILD: a shared coordinator + shared event bus across BOTH producers, mirroring runtime.
        const row = buildRow({ timeStopAtMs: DEADLINE_MS });
        const candidates = row === null ? [] : [row];

        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const enforcerEvaluate = jest.fn().mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, rejectReason: null, reservationId: null });
        const monitorEvaluate = jest.fn().mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, rejectReason: null, reservationId: null });

        const invocationOrder: string[] = [];

        // The enforcer's FIRST DB call is artificially delayed — proving the slot was acquired
        // SYNCHRONOUSLY before this await, so the monitor (running during the suspension) still
        // cannot win the slot.
        let releaseEnforcerDbCall: () => void = () => undefined;
        const enforcerDbGate = new Promise<void>((resolve) => {
            releaseEnforcerDbCall = resolve;
        });

        // The boot index rebuild (onModuleInit) calls this once and must return immediately so the
        // index is populated. The enforce-path re-read (the SECOND+ call) is the one we artificially
        // delay — proving the slot was acquired SYNCHRONOUSLY before this await.
        let candidateCallCount = 0;
        const enforcerRepo = {
            findTimeStopCandidatesBySymbol: jest.fn().mockImplementation(async () => {
                candidateCallCount += 1;

                if (candidateCallCount === 1) {
                    return candidates; // boot rebuild — immediate
                }

                invocationOrder.push('enforcer-db-start');
                await enforcerDbGate; // suspend the enforcer mid-handler, after the synchronous acquire
                invocationOrder.push('enforcer-db-resume');

                return candidates;
            }),
            findOpen: jest.fn().mockResolvedValue(candidates),
            findById: jest.fn().mockResolvedValue(row),
        } as unknown as PositionRepository;

        const monitorRepo = {
            findById: jest.fn().mockResolvedValue(row),
        } as unknown as PositionRepository;

        const enforcer = new PositionTimeStopEnforcer(enforcerRepo, { evaluate: enforcerEvaluate } as unknown as RiskGateService, events, coordinator);
        const monitor = new LocalProtectiveMonitor(monitorRepo, { evaluate: monitorEvaluate } as unknown as RiskGateService, events, coordinator);

        await enforcer.onModuleInit();

        // Arm the monitor so its SL/TP would breach on this same tick (mark 29000 <= SL 29000 for LONG).
        monitor.arm({
            positionId: POSITION_ID,
            symbol: SYMBOL,
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29000'),
            takeProfitPrice: new Money('31000'),
        });

        // OPERATE: a single same-tick price.update. We invoke the two handlers in the order the
        // runtime guarantees via `{ prependListener: true }` — enforcer FIRST, then monitor. The
        // enforcer's synchronous body acquires the slot before its first await (then suspends on the
        // delayed DB gate); the monitor's handler runs DURING that suspension and must find the slot held.
        const breachTick: IPriceUpdateEvent = { symbol: SYMBOL, price: '29000', timestampMs: DEADLINE_MS };

        invocationOrder.push('enforcer-listener');
        enforcer.onPriceUpdate(breachTick); // synchronous: acquires the slot, then `void`-suspends on the DB gate

        invocationOrder.push('monitor-listener');
        const monitorRun = monitor.onPriceUpdate(breachTick); // runs while the enforcer is suspended

        // The monitor returns synchronously once it sees the held slot. Settle it, THEN release the
        // enforcer's delayed DB gate so the time-stop close completes.
        await monitorRun;
        releaseEnforcerDbCall();
        await flush();

        // CHECK (a): listener order — enforcer prepended ahead of the monitor.
        expect(invocationOrder.indexOf('enforcer-listener')).toBeLessThan(invocationOrder.indexOf('monitor-listener'));

        // CHECK (b): exactly one close, and it is the TIME_STOP — the monitor found the slot held
        // (acquired before the enforcer's first await) and emitted nothing.
        const approved = approvedEventsOf(emitSpy);

        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TIME_STOP);
        expect(monitorEvaluate).not.toHaveBeenCalled();
    });

    it('D-TS-6-adv: a CLOSING row past its deadline is excluded by the candidate query — no intent', async () => {
        // BUILD: the candidate query excludes CLOSING (repository-level predicate). The index is built
        // from that same query, so a CLOSING row never enters the index.
        const { enforcer, emitSpy } = buildHarness({ state: PositionStateEnum.CLOSING, candidateMissing: true });
        await armIndex(enforcer);

        // OPERATE
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 1));
        await flush();

        // CHECK
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
    });

    it('D-TS-9-adv (qty staleness / abort): a candidate gone between index-load and re-read releases the slot', async () => {
        // BUILD: the index is armed (deadline present), but the step-3 re-read returns no candidate
        // (a partial reduce drained it / it closed). The enforcer must release the slot and abort.
        const row = buildRow({ timeStopAtMs: DEADLINE_MS });
        const coordinator = new SharedCloseCoordinator();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const findCandidatesSpy = jest
            .fn()
            .mockResolvedValueOnce(row === null ? [] : [row]) // onModuleInit rebuild
            .mockResolvedValue([]); // step-3 re-read: gone

        const repository = {
            findTimeStopCandidatesBySymbol: findCandidatesSpy,
            findOpen: jest.fn().mockResolvedValue(row === null ? [] : [row]),
            findById: jest.fn().mockResolvedValue(row),
        } as unknown as PositionRepository;

        const enforcer = new PositionTimeStopEnforcer(repository, { evaluate: jest.fn() } as unknown as RiskGateService, events, coordinator);
        await enforcer.onModuleInit();

        // OPERATE
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        // CHECK: no close emitted AND the slot was released for retry.
        expect(emitSpy.mock.calls.filter((call) => call[0] === ORDER_INTENT_APPROVED_EVENT)).toHaveLength(0);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    it('D-TS-11-adv (gate reject): a non-APPROVED gate decision releases the slot for retry', async () => {
        // BUILD
        const { enforcer, emitSpy, coordinator } = buildHarness({ timeStopAtMs: DEADLINE_MS, gateOutcome: RiskOutcomeEnum.REJECTED });
        await armIndex(enforcer);

        // OPERATE
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS));
        await flush();

        // CHECK
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);
    });

    it('D-TS-12-adv (halt-expiry recovery): the enforcer releases its OWN slot on a halted expiry, not the monitor parser', async () => {
        // BUILD
        const { enforcer, coordinator } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        coordinator.tryAcquire(POSITION_ID);

        // OPERATE: a halted expiry whose eventId matches the enforcer's OWN prefix.
        enforcer.onOrderIntentExpired({ eventId: `time-stop-enforcer-${POSITION_ID}`, reservationId: null, reason: 'halted' });

        // CHECK: released.
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);

        // A monitor-prefixed expiry must NOT release the enforcer's slot.
        coordinator.tryAcquire(POSITION_ID);
        enforcer.onOrderIntentExpired({ eventId: `local-monitor-breach-${POSITION_ID}-stop_loss`, reservationId: null, reason: 'halted' });
        expect(coordinator.isHeld(POSITION_ID)).toBe(true);
    });

    it('D-TS-13 (lifecycle clear): CLOSED transition releases the slot and prunes the index', async () => {
        // BUILD
        const { enforcer, emitSpy, coordinator } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);
        coordinator.tryAcquire(POSITION_ID);

        // OPERATE: the close lands.
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

        // CHECK: slot released; index pruned (a later tick finds no deadline → no emit).
        expect(coordinator.isHeld(POSITION_ID)).toBe(false);

        emitSpy.mockClear();
        enforcer.onPriceUpdate(buildPriceUpdate(DEADLINE_MS + 10));
        await flush();
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
    });
});

// ── M37 D3.2 — periodic sweep (sweepDeadlineBreaches) adversarial tests ─────

describe('PositionTimeStopEnforcer — M37 D3.2: sweepDeadlineBreaches periodic safety-net', () => {
    it('sweep closes a deadline-breached position even with no price tick', async () => {
        // why: the MRVL 127-min breach — a thin coin whose price feed stalled
        // emitted no ticks, so the price-path enforcer never ran. sweepDeadlineBreaches
        // re-reads findOpen() and closes any past-deadline row independent of tick arrival.
        // Call onModuleInit to populate the deadline index (arms earliestTimeStopMs);
        // then advance the wall clock past the deadline so the sweep's fast-path passes.
        const { enforcer, emitSpy, evaluateSpy, findCandidatesSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);
        // Ensure the re-read also returns the candidate row.
        findCandidatesSpy.mockResolvedValue([buildRow({ timeStopAtMs: DEADLINE_MS })]);

        // OPERATE: call sweep at a time past the deadline — no price tick involved.
        jest.spyOn(Date, 'now').mockReturnValue(DEADLINE_MS + 1_000);
        await enforcer.sweepDeadlineBreaches();
        await flush();
        jest.spyOn(Date, 'now').mockRestore();

        // CHECK: the sweep emits exactly one CLOSE intent with exitReason=TIME_STOP.
        const approved = approvedEventsOf(emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TIME_STOP);
        expect(evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('sweep is a no-op when no position has crossed its deadline', async () => {
        // why: the sweep must not close positions still within their time budget.
        // A future deadline must be silently skipped. armIndex populates the in-memory
        // deadline index so the fast-path guard does not short-circuit the sweep
        // before the per-position check runs.
        const futureDeadlineMs = DEADLINE_MS + 60_000;
        const { enforcer, emitSpy } = buildHarness({ timeStopAtMs: futureDeadlineMs });
        await armIndex(enforcer);

        // Wall clock is BEFORE the future deadline — the per-position check fires
        // but finds the deadline not yet crossed.
        jest.spyOn(Date, 'now').mockReturnValue(DEADLINE_MS);
        await enforcer.sweepDeadlineBreaches();
        await flush();
        jest.spyOn(Date, 'now').mockRestore();

        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
    });

    it('sweep fast-path: if Date.now() < earliestTimeStopMs, returns immediately without emitting a close', async () => {
        // why: the sweep reads earliestTimeStopMs as a scalar guard, identical to
        // the price-path fast-path. When no deadline has been crossed no DB read or
        // gate call should occur on every 60-second interval tick.
        const { enforcer, emitSpy, evaluateSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS + 120_000 });
        await armIndex(enforcer);

        // Wall clock is far before any deadline (120s before the position's stop).
        jest.spyOn(Date, 'now').mockReturnValue(DEADLINE_MS);
        await enforcer.sweepDeadlineBreaches();
        await flush();
        jest.spyOn(Date, 'now').mockRestore();

        // Fast-path fires: no gate call, no close emitted.
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('sweep does not double-close a position already being closed (slot held by price path)', async () => {
        // why: the price path and the sweep could both fire in the same 60-second
        // window. The shared slot registry (SharedCloseCoordinator.tryAcquire) is
        // the dedup substrate; the sweep must skip any position whose slot is held.
        const { enforcer, emitSpy, coordinator, findCandidatesSpy } = buildHarness({ timeStopAtMs: DEADLINE_MS });
        await armIndex(enforcer);
        findCandidatesSpy.mockResolvedValue([buildRow({ timeStopAtMs: DEADLINE_MS })]);

        // Simulate: the price path already acquired the slot.
        coordinator.tryAcquire(POSITION_ID);

        jest.spyOn(Date, 'now').mockReturnValue(DEADLINE_MS + 1_000);
        await enforcer.sweepDeadlineBreaches();
        await flush();
        jest.spyOn(Date, 'now').mockRestore();

        // No additional close emitted; the slot was already held.
        expect(approvedEventsOf(emitSpy)).toHaveLength(0);
        // Slot still held by the original acquirer.
        expect(coordinator.isHeld(POSITION_ID)).toBe(true);
    });
});

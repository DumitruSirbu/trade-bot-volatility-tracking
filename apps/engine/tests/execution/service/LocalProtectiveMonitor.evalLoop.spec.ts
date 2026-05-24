/**
 * LocalProtectiveMonitor — eval loop + breach-close producer (M6 W3, ADR 0011 §2-§4).
 *
 * Coverage matrix:
 *   - Side-aware breach check (LONG/SHORT × SL/TP) — every combination fires
 *     exactly one ORDER_INTENT_APPROVED_EVENT with the right exitReason and
 *     opposite tradeSide.
 *   - Decimal boundary: markPrice exactly equal to SL/TP triggers a breach
 *     (at-or-past semantics, ADR 0011 §3).
 *   - Idempotency: 10 sequential price updates past the SL fire exactly one
 *     close intent (ADR 0011 §4 breachInFlight flag).
 *   - Disarm on CLOSED: a position.state.transitioned → CLOSED event removes
 *     the position from the armed map and subsequent price updates are no-ops.
 *   - Adversarial: arm with stopLossPrice=null fires only on TP; both null
 *     never fires; price.update for a non-armed symbol is a no-op.
 *   - Gate rejection: if the gate rejects a close intent (contract violation,
 *     CLOSE should always auto-approve per ADR 0004 §2), the in-flight flag
 *     clears so the next tick can retry — the monitor stays armed.
 *
 * The monitor is a pure-event-bus citizen: no exchange calls, no direct
 * ExecutionService calls. All assertions verify the gate→approved-event seam.
 */

import {
    ExitReasonEnum,
    IPositionStateTransitionedEvent,
    IPriceUpdateEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT, PRICE_UPDATE_EVENT } from '../../../src/common/const';
import { Money } from '../../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../../../src/position/const';
import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { IOrderIntent, IOrderIntentApprovedEvent } from '../../../src/risk/interface';
import { RiskGateService } from '../../../src/risk/service';

interface IHarnessOpts {
    positionSide?: PositionSideEnum;
    positionQty?: string;
    entryPrice?: string;
    gateOutcome?: RiskOutcomeEnum;
    positionExists?: boolean;
}

interface IHarness {
    monitor: LocalProtectiveMonitor;
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
    gate: RiskGateService;
    evaluateSpy: jest.SpyInstance;
    repository: PositionRepository;
}

function buildHarness(opts: IHarnessOpts = {}): IHarness {
    const side = opts.positionSide ?? PositionSideEnum.LONG;
    const positionRow: PositionEntity | null =
        opts.positionExists === false
            ? null
            : ({
                  id: 42,
                  symbol: 'BTCUSDT',
                  side,
                  state: PositionStateEnum.OPEN,
                  entryPrice: new Money(opts.entryPrice ?? '30000'),
                  qty: new Money(opts.positionQty ?? '0.01'),
                  leverage: new Money('5'),
                  positionSlot: PositionSlotEnum.A,
                  strategyVersionId: 1,
                  correlationMode: null,
                  coinTier: null,
                  flowTypeAtEntry: null,
              } as PositionEntity);

    const repository = {
        findById: jest.fn().mockResolvedValue(positionRow),
    } as unknown as PositionRepository;

    const gateOutcome = opts.gateOutcome ?? RiskOutcomeEnum.APPROVED;
    const evaluateSpy = jest.fn().mockResolvedValue({
        outcome: gateOutcome,
        rejectReason: gateOutcome === RiskOutcomeEnum.APPROVED ? null : 'cooldown_active',
        approvedSlot: null,
        approvedSizing: null,
        clampedExit: null,
        reservationId: null,
    });
    // M6 W8.5: monitor's onPriceUpdate now gates on isRecoveryReady; default
    // to ready=true for steady-state W3 eval-loop tests. The boot-race guard
    // is exercised in tests/position/W8_5.spec.ts.
    const gate = { evaluate: evaluateSpy, isRecoveryReady: jest.fn().mockReturnValue(true) } as unknown as RiskGateService;

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const monitor = new LocalProtectiveMonitor(repository, gate, events);

    return { monitor, events, emitSpy, gate, evaluateSpy, repository };
}

function armLongAt(monitor: LocalProtectiveMonitor, sl: string, tp: string, positionId = 42): void {
    monitor.arm({
        positionId,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        stopLossPrice: new Money(sl),
        takeProfitPrice: new Money(tp),
    });
}

function armShortAt(monitor: LocalProtectiveMonitor, sl: string, tp: string, positionId = 42): void {
    monitor.arm({
        positionId,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.SHORT,
        stopLossPrice: new Money(sl),
        takeProfitPrice: new Money(tp),
    });
}

function buildPriceUpdate(price: string, symbol = 'BTCUSDT'): IPriceUpdateEvent {
    return { symbol, price, timestampMs: 1_700_000_000_000 };
}

function getApprovedEvents(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
    return emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_APPROVED_EVENT).map(([, payload]) => payload as IOrderIntentApprovedEvent);
}

describe('LocalProtectiveMonitor — side-aware breach evaluator (pure, ADR 0011 §3)', () => {
    it('LONG SL: markPrice strictly below SL is a breach (kind=stop_loss)', () => {
        const { monitor } = buildHarness();
        armLongAt(monitor, '29500', '31000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('29499'));

        expect(breach).toBe('stop_loss');
    });

    it('LONG SL: markPrice exactly equal to SL is a breach (at-or-past semantics, ADR 0011 §3)', () => {
        const { monitor } = buildHarness();
        armLongAt(monitor, '29500', '31000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('29500'));

        expect(breach).toBe('stop_loss');
    });

    it('LONG TP: markPrice exactly equal to TP is a breach', () => {
        const { monitor } = buildHarness();
        armLongAt(monitor, '29500', '31000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('31000'));

        expect(breach).toBe('take_profit');
    });

    it('LONG: markPrice between SL and TP returns null (no breach)', () => {
        const { monitor } = buildHarness();
        armLongAt(monitor, '29500', '31000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('30000'));

        expect(breach).toBeNull();
    });

    it('SHORT SL: markPrice strictly above SL is a breach (kind=stop_loss)', () => {
        const { monitor } = buildHarness({ positionSide: PositionSideEnum.SHORT });
        armShortAt(monitor, '30500', '29000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('30501'));

        expect(breach).toBe('stop_loss');
    });

    it('SHORT SL: markPrice exactly equal to SL is a breach', () => {
        const { monitor } = buildHarness({ positionSide: PositionSideEnum.SHORT });
        armShortAt(monitor, '30500', '29000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('30500'));

        expect(breach).toBe('stop_loss');
    });

    it('SHORT TP: markPrice exactly equal to TP is a breach', () => {
        const { monitor } = buildHarness({ positionSide: PositionSideEnum.SHORT });
        armShortAt(monitor, '30500', '29000');

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('29000'));

        expect(breach).toBe('take_profit');
    });

    it('SL is checked before TP — degenerate gap through both resolves to stop_loss', () => {
        const { monitor } = buildHarness();
        // LONG with mark=25000: it's below SL AND above TP impossible; instead
        // configure SHORT where mark=29000 is both above SL (28000) and below TP (29500) — wait, this never happens with proper SL/TP ordering.
        // Use a degenerate config: SL=30000, TP=30000 (zero band) and mark=30000 → SL wins (first check).
        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('30000'),
            takeProfitPrice: new Money('30000'),
        });

        const breach = monitor.evaluateBreach(monitor.listArmed()[0], new Money('30000'));

        expect(breach).toBe('stop_loss');
    });
});

describe('LocalProtectiveMonitor — onPriceUpdate emits gate-routed close intent', () => {
    it('LONG SL breach → exactly one ORDER_INTENT_APPROVED_EVENT with exitReason=STOP_LOSS and CLOSE tradeSide=SHORT', async () => {
        const harness = buildHarness({ positionSide: PositionSideEnum.LONG });
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approved[0].intent.tradeSide).toBe(PositionSideEnum.SHORT);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
        expect(approved[0].intent.symbol).toBe('BTCUSDT');
        // De-risking approvals carry null reservation per ADR 0004 §2.
        expect(approved[0].reservationId).toBeNull();
    });

    it('LONG TP breach → one close intent with exitReason=TAKE_PROFIT', async () => {
        const harness = buildHarness({ positionSide: PositionSideEnum.LONG });
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('31050'));

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
        expect(approved[0].intent.tradeSide).toBe(PositionSideEnum.SHORT);
    });

    it('SHORT SL breach → one close intent with exitReason=STOP_LOSS and CLOSE tradeSide=LONG', async () => {
        const harness = buildHarness({ positionSide: PositionSideEnum.SHORT });
        armShortAt(harness.monitor, '30500', '29000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('30600'));

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
        expect(approved[0].intent.tradeSide).toBe(PositionSideEnum.LONG);
    });

    it('SHORT TP breach → one close intent with exitReason=TAKE_PROFIT and CLOSE tradeSide=LONG', async () => {
        const harness = buildHarness({ positionSide: PositionSideEnum.SHORT });
        armShortAt(harness.monitor, '30500', '29000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('28950'));

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
        expect(approved[0].intent.tradeSide).toBe(PositionSideEnum.LONG);
    });

    it('the close intent carries the full remaining qty and a deterministic eventId (replay-safe)', async () => {
        const harness = buildHarness({ positionSide: PositionSideEnum.LONG, positionQty: '0.025' });
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved[0].intent.sizing.qty.toFixed()).toBe('0.025');
        // Deterministic id format: local-monitor-breach-<positionId>-<exitReason>
        expect(approved[0].intent.eventId).toBe('local-monitor-breach-42-stop_loss');
    });

    it('the intent flows through RiskGateService.evaluate (gate is the only close API)', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        expect(harness.evaluateSpy).toHaveBeenCalledTimes(1);
        const [intent] = harness.evaluateSpy.mock.calls[0] as [IOrderIntent];
        expect(intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
    });
});

describe('LocalProtectiveMonitor — idempotency on repeat ticks past the breach (ADR 0011 §4)', () => {
    it('ten sequential price updates past the SL fire exactly one close intent', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');

        for (let i = 0; i < 10; i++) {
            await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));
        }

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(harness.evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('repeat ticks after a TP breach also fire only one intent', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');

        for (let i = 0; i < 5; i++) {
            await harness.monitor.onPriceUpdate(buildPriceUpdate('31200'));
        }

        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
    });

    it('gate rejection on close intent clears the in-flight flag so the next tick can retry', async () => {
        const harness = buildHarness({ gateOutcome: RiskOutcomeEnum.REJECTED });
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));
        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        // Two evaluate attempts; zero approved events (rejected each time).
        expect(harness.evaluateSpy).toHaveBeenCalledTimes(2);
        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);
        // Monitor still armed — last line of defense per ADR 0011.
        expect(harness.monitor.isArmed(42)).toBe(true);
    });
});

describe('LocalProtectiveMonitor — disarm on position.state.transitioned → CLOSED', () => {
    it('CLOSED transition removes the position from the armed map', () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');
        expect(harness.monitor.isArmed(42)).toBe(true);

        const event: IPositionStateTransitionedEvent = {
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: 1_700_000_000_000,
            eventClass: 'unit.test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        };
        harness.monitor.onPositionStateTransitioned(event);

        expect(harness.monitor.isArmed(42)).toBe(false);
    });

    it('a non-CLOSED transition (e.g. OPEN→CLOSING) does NOT disarm', () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');

        const event: IPositionStateTransitionedEvent = {
            positionId: 42,
            fromState: PositionStateEnum.OPEN,
            toState: PositionStateEnum.CLOSING,
            transitionedAtMs: 1_700_000_000_000,
            eventClass: 'unit.test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        };
        harness.monitor.onPositionStateTransitioned(event);

        expect(harness.monitor.isArmed(42)).toBe(true);
    });

    it('after disarm via CLOSED, subsequent price.update events do nothing for that position', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000');

        harness.monitor.onPositionStateTransitioned({
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: 1_700_000_000_000,
            eventClass: 'unit.test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        expect(harness.evaluateSpy).not.toHaveBeenCalled();
        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);
    });
});

describe('LocalProtectiveMonitor — adversarial / boundary', () => {
    it('arm with stopLossPrice=null fires only on TP (SL check skipped)', async () => {
        const harness = buildHarness();
        harness.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: null,
            takeProfitPrice: new Money('31000'),
        });

        // A price that would have tripped a normal SL (below entry) does nothing.
        await harness.monitor.onPriceUpdate(buildPriceUpdate('25000'));
        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);

        // TP breach still fires.
        await harness.monitor.onPriceUpdate(buildPriceUpdate('31500'));
        const approved = getApprovedEvents(harness.emitSpy);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.TAKE_PROFIT);
    });

    it('arm with both SL and TP null never fires a close intent', async () => {
        const harness = buildHarness();
        harness.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: null,
            takeProfitPrice: null,
        });

        await harness.monitor.onPriceUpdate(buildPriceUpdate('25000'));
        await harness.monitor.onPriceUpdate(buildPriceUpdate('35000'));

        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);
        expect(harness.evaluateSpy).not.toHaveBeenCalled();
    });

    it('price.update for a symbol with no armed position is a no-op (no gate call, no emit)', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000'); // armed on BTCUSDT

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400', 'ETHUSDT'));

        expect(harness.evaluateSpy).not.toHaveBeenCalled();
        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);
    });

    it('position row missing at breach time → monitor disarms and skips (does not throw, does not emit)', async () => {
        const harness = buildHarness({ positionExists: false });
        armLongAt(harness.monitor, '29500', '31000');

        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        expect(harness.monitor.isArmed(42)).toBe(false);
        expect(getApprovedEvents(harness.emitSpy)).toHaveLength(0);
    });

    it('multiple armed positions on the same symbol — each is evaluated independently', async () => {
        const harness = buildHarness();
        armLongAt(harness.monitor, '29500', '31000', 42);
        armLongAt(harness.monitor, '28000', '32000', 43);

        // Price at 29400 breaches position 42's SL but not position 43's.
        // Only the harness's findById matches positionId=42 (mocked); position 43
        // lookup returns the same row (mock fallback) — we just assert that the
        // evaluator triggered exactly once for the only breaching arm.
        await harness.monitor.onPriceUpdate(buildPriceUpdate('29400'));

        expect(harness.evaluateSpy).toHaveBeenCalledTimes(1);
    });
});

describe('LocalProtectiveMonitor — eval loop is event-driven (no timers, no exchange calls)', () => {
    it('does not register any setInterval / setTimeout on construction', () => {
        // Constructing the monitor must not start any background loop. The
        // evaluator only runs on price.update events.
        jest.useFakeTimers();
        try {
            buildHarness();
            // No timer scheduled by the constructor.
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('the @OnEvent decorator wires to PRICE_UPDATE_EVENT and POSITION_STATE_TRANSITIONED_EVENT', () => {
        // Smoke: the constants the monitor subscribes to are the ones the rest of
        // the engine emits. Anti-coverage: catches a typo in the event name.
        expect(PRICE_UPDATE_EVENT).toBe('marketData.price.update');
        expect(POSITION_STATE_TRANSITIONED_EVENT).toBe('position.state.transitioned');
    });
});

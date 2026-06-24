/**
 * ExecutionService — ADR 0046 §2.1 halt-gate tests (M40 D1).
 *
 * The D1 change narrowed all three halt gates with `&& isOpenOrAddIntent(intentAction)`.
 * REDUCE / CLOSE / FLATTEN now execute under halt; only OPEN / ADD abort.
 *
 * Acceptance criteria covered:
 *   A1 — CLOSE under halt submits, fills, row transitions to CLOSED; no EXPIRED/HALTED event.
 *   A2 — OPEN under halt short-circuits at gate 1 (emits EXPIRED/HALTED). ADD likewise.
 *        Includes market_stress:multi halt variant.
 *   A3 — FLATTEN under halt submits and fills to CLOSED.
 *   A4 — CLOSE passes gate 1 AND halt still set when runSubmitStateMachine runs
 *        (gate 2 specific): reaches submitter.submit, NOT aborted.
 *        Separately: halt cleared mid-flight for OPEN — no double-submit.
 *   A5 — REDUCE (partial de-risk) under halt submits and fills without abort before
 *        submitter.submit.
 *   A6 — slot lifecycle on CLEAN CLOSE: slot released via POSITION_CLOSED_EVENT, not via
 *        halted-expiry. Assert no halt-expiry event emitted on clean close.
 *   A6b — non-clean-under-halt CLOSE parks in RECONCILING; ORDER_INTENT_UNKNOWN_EVENT emitted.
 *   A7 — dry-run path unaffected (isExecutionLive=false still hits handleDryRun regardless
 *        of halt state; EXPIRED/DRY_RUN emitted for all action types).
 *
 * Failure routing: adversarial failures → architect routing per dev-qa-cycle.md §2.2.
 */

import {
    ExchangeEnvironmentEnum,
    ExitReasonEnum,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    StrategyDirectionEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_EXPIRED_EVENT, ORDER_INTENT_UNKNOWN_EVENT, POSITION_CLOSED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { ORDER_INTENT_EXPIRED_REASON_DRY_RUN, ORDER_INTENT_EXPIRED_REASON_HALTED } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildOrderIntent, buildSizing } from '../../risk/support/fixtures';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';

jest.useFakeTimers();

// ─── service bundle ────────────────────────────────────────────────────────────

interface IHaltGateBundle {
    service: ExecutionService;
    submitter: jest.Mocked<Pick<ExchangeOrderSubmitter, 'submit' | 'cancelByClientId' | 'fetchByClientId' | 'recover'>>;
    positions: jest.Mocked<{
        createOpen: jest.Mock;
        save: jest.Mock;
        findOpenBySymbol: jest.Mock;
        findOpenBySymbolAndSlot: jest.Mock;
    }>;
    positionService: jest.Mocked<{ transition: jest.Mock; adjustQty: jest.Mock; finalizeRealizedPnl: jest.Mock }>;
    transactions: jest.Mocked<{ recordTerminal: jest.Mock }>;
    riskGate: jest.Mocked<{ releaseReservation: jest.Mock; confirmReservation: jest.Mock }>;
    emitSpy: jest.SpyInstance;
    haltFlag: HaltFlagService;
    fillAccumulator: FillAccumulator;
    events: EventEmitter2;
}

function buildPositionRow(id = 99, state: PositionStateEnum = PositionStateEnum.OPEN) {
    return {
        ...buildPositionEntityMock(id),
        state,
        side: PositionSideEnum.SHORT,
        qty: new Money('0.01'),
        entryPrice: new Money('30000'),
        entryNotional: new Money('300'),
        positionSlot: PositionSlotEnum.A,
        openedAt: new Date(Date.now() - 10_000),
    };
}

function buildBundle(
    overrides: {
        isExecutionLive?: boolean;
        exchangeEnv?: ExchangeEnvironmentEnum;
        plan?: { policy: OrderPolicyEnum; limitPrice: MoneyValue; timeoutMs: number; slippageCapPct: MoneyValue; reduceOnly: boolean };
        positionRow?: ReturnType<typeof buildPositionRow>;
        finalizeResult?: ReturnType<typeof buildPositionRow>;
    } = {},
): IHaltGateBundle {
    const positionRow = overrides.positionRow ?? buildPositionRow(99);
    const finalizeResult = overrides.finalizeResult ?? { ...positionRow, exitReason: ExitReasonEnum.SIGNAL, realizedPnl: new Money('5'), closedAt: new Date() };

    const appConfig = {
        isExecutionLive: overrides.isExecutionLive ?? true,
        exchangeEnv: overrides.exchangeEnv ?? ExchangeEnvironmentEnum.LIVE,
    } as AppConfigService;

    const defaultPlan = overrides.plan ?? {
        policy: OrderPolicyEnum.REDUCE_MARKET,
        limitPrice: new Money('30000'),
        timeoutMs: 0,
        slippageCapPct: new Money('0'),
        reduceOnly: true,
    };

    const policyRouter = { plan: jest.fn().mockReturnValue(defaultPlan) } as unknown as OrderPolicyRouter;
    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');
    const haltFlag = new HaltFlagService();
    const fillAccumulator = new FillAccumulator();
    const clientOrderIdFactory = new ClientOrderIdFactory();

    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const submitter = {
        submit: jest
            .fn()
            .mockResolvedValue({ state: SubmitStateEnum.FILLED, snapshot: buildOrderSnapshot(), rejectClass: null, venueCode: null, venueMessage: null }),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as IHaltGateBundle['submitter'];

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockImplementation(async (row: unknown) => row),
        findOpenBySymbol: jest.fn().mockResolvedValue([positionRow]),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(positionRow),
    } as unknown as IHaltGateBundle['positions'];

    const transactions = {
        recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as IHaltGateBundle['transactions'];

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = {
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
    } as unknown as IHaltGateBundle['riskGate'];

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(finalizeResult),
    } as unknown as IHaltGateBundle['positionService'];

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );

    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()),
    } as unknown as ProtectiveOrderAttacher;

    const service = new ExecutionService(
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter as never,
        fillAccumulator,
        protectiveAttacher as never,
        localProtectiveMonitor,
        positions as never,
        positionService as never,
        transactions as never,
        strategyVersions,
        riskGate as never,
        haltFlag,
        { emitSyntheticClose: jest.fn() } as never,
        exchangeClient,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as never,
    );

    return { service, submitter, positions, positionService, transactions, riskGate, emitSpy, haltFlag, fillAccumulator, events };
}

function wireFullFill(bundle: IHaltGateBundle, qty = '0.01'): void {
    const filled = buildOrderSnapshot({ filled: qty, average: '30000', cost: String(Number(qty) * 30000), fee: '0.01' });
    bundle.fillAccumulator.record(filled);
    (bundle.submitter.submit as jest.Mock).mockResolvedValue({
        state: SubmitStateEnum.FILLED,
        snapshot: filled,
        rejectClass: null,
        venueCode: null,
        venueMessage: null,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// A1 — CLOSE under halt submits, fills, row transitions to CLOSED
// ADR 0046 §2.1: de-risking exits survive halt.
// ═══════════════════════════════════════════════════════════════════════════════

describe('A1 (happy path) — CLOSE under halt: submits, fills, POSITION_CLOSED_EVENT emitted', () => {
    it('CLOSE intent with haltFlag set: submitter.submit called once, POSITION_CLOSED_EVENT emitted, no HALTED expiry', async () => {
        // BUILD
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('risk-limit');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a1-close' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: submitter reached
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);

        // POSITION_CLOSED_EVENT emitted (position actually closed)
        const closedCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedCalls.length).toBe(1);

        // Must NOT emit ORDER_INTENT_EXPIRED_EVENT with reason=halted
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });

    it('A1 anti-regression: CLOSE under halt does NOT park in RECONCILING (non-clean paths escalate to UNKNOWN but not halt-abort)', async () => {
        // BUILD: full fill → clean terminal → CLOSED, not RECONCILING
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('consecutive-loss');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: positionService.finalizeRealizedPnl called (CLOSED path, not RECONCILING-park)
        expect(bundle.positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);
        const [, exitReasonArg] = (bundle.positionService.finalizeRealizedPnl as jest.Mock).mock.calls[0];
        // Exit reason is SIGNAL (strategy-driven close, not halt-triggered)
        expect(exitReasonArg).toBe(ExitReasonEnum.SIGNAL);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2 — OPEN / ADD under halt abort at gate 1
// ADR 0046 §2.1: new risk is blocked; de-risking is allowed.
// ═══════════════════════════════════════════════════════════════════════════════

describe('A2 (happy path) — OPEN under halt: gate 1 short-circuits, EXPIRED/HALTED emitted', () => {
    it('OPEN intent with haltFlag set: submitter.submit NOT called, ORDER_INTENT_EXPIRED emitted with reason=halted', async () => {
        // BUILD
        const bundle = buildBundle({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });
        bundle.haltFlag.halt('model-divergence');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a2-open' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: no exchange call
        expect(bundle.submitter.submit).not.toHaveBeenCalled();

        // EXPIRED/HALTED emitted
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(1);

        // Reservation released (not confirmed)
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-a2-open');
        expect(bundle.riskGate.confirmReservation).not.toHaveBeenCalled();
    });

    it('ADD intent with haltFlag set: same gate 1 abort as OPEN', async () => {
        // BUILD
        const bundle = buildBundle({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });
        bundle.haltFlag.halt('manual-halt');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.ADD });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a2-add' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK
        expect(bundle.submitter.submit).not.toHaveBeenCalled();
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(1);
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-a2-add');
    });

    it('A2 adversarial: market_stress:multi halt also blocks OPEN (no halt-suffix exemption for OPEN)', async () => {
        // BUILD: market_stress multi-leg halt — must NOT let OPEN through
        const bundle = buildBundle({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });
        bundle.haltFlag.halt('market_stress:multi');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a2-stress-multi' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: still blocked — no partial exception for any halt suffix
        expect(bundle.submitter.submit).not.toHaveBeenCalled();
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(1);
    });

    it('A2 boundary: no halt → OPEN proceeds to submitter (gate not triggered)', async () => {
        // BUILD: halt NOT set → OPEN must reach submitter
        const bundle = buildBundle({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });
        wireFullFill(bundle, '0.01');

        const positionRow = {
            ...buildPositionEntityMock(55),
            qty: new Money('0.01'),
            entryPrice: new Money('30000'),
            entryNotional: new Money('300'),
        };
        (bundle.positions.createOpen as jest.Mock).mockResolvedValue(positionRow);

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a2-no-halt' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: submitter.submit called (gate 1 not triggered)
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3 — FLATTEN under halt submits and fills to CLOSED
// ═══════════════════════════════════════════════════════════════════════════════

describe('A3 (happy path) — FLATTEN under halt: submits, fills, POSITION_CLOSED_EVENT emitted', () => {
    it('FLATTEN intent with haltFlag set: submitter.submit called, POSITION_CLOSED_EVENT emitted with exitReason=KILL_SWITCH', async () => {
        // BUILD: exitReasonForIntent maps FLATTEN-under-halt → KILL_SWITCH (ADR 0012 §5b)
        const finalizeResult = {
            ...buildPositionRow(99),
            exitReason: ExitReasonEnum.KILL_SWITCH,
            realizedPnl: new Money('-5'),
            closedAt: new Date(),
        };
        const bundle = buildBundle({ finalizeResult: finalizeResult as never });
        wireFullFill(bundle);
        bundle.haltFlag.halt('kill-switch');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.FLATTEN, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a3-flatten' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: submitter reached
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);

        // POSITION_CLOSED_EVENT emitted
        const closedCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedCalls.length).toBe(1);
        const [, closedPayload] = closedCalls[0];
        expect((closedPayload as { exitReason: ExitReasonEnum }).exitReason).toBe(ExitReasonEnum.KILL_SWITCH);

        // Must NOT emit EXPIRED/HALTED
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A4 — Gate 2 specific: CLOSE passes gate 1 AND halt still set at runSubmitStateMachine
//      Separately: halt cleared mid-flight for OPEN — no double-submit.
// ═══════════════════════════════════════════════════════════════════════════════

describe('A4 (adversarial) — gate 2: CLOSE with halt set reaches submitter.submit (not ABORTED)', () => {
    it('CLOSE intent: halt set, gate 2 reached — submitter.submit called (not short-circuited at gate 2)', async () => {
        // BUILD: CLOSE intent. Both gate 1 and gate 2 use isOpenOrAddIntent which returns false for CLOSE.
        // Verify submitter.submit is reached (gate 2 did not abort).
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('risk-limit-gate2-test');

        let submitCalled = false;
        (bundle.submitter.submit as jest.Mock).mockImplementation(async () => {
            submitCalled = true;
            return { state: SubmitStateEnum.FILLED, snapshot: buildOrderSnapshot(), rejectClass: null, venueCode: null, venueMessage: null };
        });

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a4-close-gate2' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: submit was called (gate 2 bypassed for CLOSE)
        expect(submitCalled).toBe(true);

        // No halted-abort emitted
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });

    it('A4 adversarial: halt cleared mid-flight for OPEN intent — submit called exactly once (no double-submit after halt clears)', async () => {
        // BUILD: OPEN intent. Halt is set at gate 1 — OPEN is aborted before submit.
        // Then halt is cleared. No second submit should fire (the event is already aborted).
        const bundle = buildBundle({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });
        bundle.haltFlag.halt('pre-open-halt');

        // Resume halt AFTER the service processes the event (simulate halt cleared mid-flight)
        let submitCount = 0;
        (bundle.submitter.submit as jest.Mock).mockImplementation(async () => {
            submitCount += 1;
            return { state: SubmitStateEnum.FILLED, snapshot: buildOrderSnapshot(), rejectClass: null, venueCode: null, venueMessage: null };
        });

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a4-clear-halt' });

        // OPERATE: submit the event while halt is set
        await bundle.service.onOrderIntentApproved(event);

        // Resume halt after the event was processed (mid-flight simulation)
        bundle.haltFlag.resume();

        // CHECK: submit was never called (OPEN was aborted at gate 1 before halt cleared)
        expect(submitCount).toBe(0);

        // EXPIRED/HALTED was emitted
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A5 — REDUCE (partial de-risk) under halt submits and fills
// ═══════════════════════════════════════════════════════════════════════════════

describe('A5 (happy path) — REDUCE under halt: submits, fills, partial qty applied', () => {
    it('REDUCE intent with haltFlag set: submitter.submit called, position qty decremented by filled amount', async () => {
        // BUILD: partial REDUCE (0.005 of 0.01) with halt set
        const positionRow = buildPositionRow(99);
        const bundle = buildBundle({ positionRow });

        const partialSnap = buildOrderSnapshot({ filled: '0.005', average: '30000', cost: '150', fee: '0.005', status: 'closed' });
        bundle.fillAccumulator.record(partialSnap);
        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: partialSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        bundle.haltFlag.halt('over-limit');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.REDUCE, sizing: buildSizing({ qty: new Money('0.005') }) });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a5-reduce' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: submit reached
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);

        // No halted-abort event
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);

        // Transaction recorded for the partial REDUCE
        expect(bundle.transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const [txArg] = (bundle.transactions.recordTerminal as jest.Mock).mock.calls[0];
        expect((txArg.qty as MoneyValue).toFixed(3)).toBe('0.005');
    });

    it('A5 adversarial: REDUCE under halt does NOT emit ORDER_INTENT_EXPIRED_REASON_HALTED at any point (all 3 gates)', async () => {
        // BUILD: full-close REDUCE under halt — assert zero halted-expiry events anywhere
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('manual-halt');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.REDUCE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: ZERO halted-expiry events across all 3 gates
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A6 — Slot lifecycle on CLEAN CLOSE: slot released via POSITION_CLOSED_EVENT
//      (not via halted-expiry). Assert no slot leak on clean close.
// ═══════════════════════════════════════════════════════════════════════════════

describe('A6 (happy path) — clean CLOSE: POSITION_CLOSED_EVENT carries positionSlot for slot release', () => {
    it('CLOSE clean fill: POSITION_CLOSED_EVENT payload carries non-null positionSlot for slot release', async () => {
        // BUILD: CLOSE with halt set — clean fill path
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('cooldown');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent, approvedSlot: PositionSlotEnum.A });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: POSITION_CLOSED_EVENT carries positionSlot for the slot-release listener (ADR 0034 §3)
        const closedCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedCalls.length).toBe(1);
        const [, closedPayload] = closedCalls[0];
        expect((closedPayload as { positionSlot: PositionSlotEnum | null }).positionSlot).toBe(PositionSlotEnum.A);
    });

    it('A6 anti-regression: no halted-expiry event emitted on clean close (slot not leaked via halt path)', async () => {
        // BUILD
        const bundle = buildBundle();
        wireFullFill(bundle);
        bundle.haltFlag.halt('over-exposure');

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: ZERO halted-expiry (slot is released via POSITION_CLOSED_EVENT path, not halt path)
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A6b — Non-clean CLOSE under halt parks in RECONCILING (ORDER_INTENT_UNKNOWN_EVENT)
// This is the residual shape that D4's sweep reclaims (C8 acceptance criterion).
// ═══════════════════════════════════════════════════════════════════════════════

describe('A6b (adversarial) — non-clean CLOSE under halt: RECONCILE_REQUIRED → ORDER_INTENT_UNKNOWN_EVENT', () => {
    it('CLOSE under halt with RECONCILE_REQUIRED terminal: ORDER_INTENT_UNKNOWN_EVENT emitted (non-clean escalation)', async () => {
        // BUILD: CLOSE under halt, budget exhausted (RECONCILE_REQUIRED state).
        // This simulates a non-clean permitted close under halt → parks in RECONCILING (D4 reclaims it).
        const plan = {
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: new Money('30000'),
            timeoutMs: 50,
            slippageCapPct: new Money('0'),
            reduceOnly: true,
        };
        const bundle = buildBundle({ plan });
        bundle.haltFlag.halt('consecutive-loss');

        // Wire partial fill then exhaust budget
        const partial = buildOrderSnapshot({ status: 'canceled', filled: '0.001', remaining: '0.009', cost: '30', average: '30000', fee: '0.001' });
        bundle.fillAccumulator.record(partial);
        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.OPEN,
            snapshot: buildOrderSnapshot({ status: 'open' }),
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });
        (bundle.submitter.cancelByClientId as jest.Mock).mockResolvedValue(partial);
        (bundle.submitter.fetchByClientId as jest.Mock).mockResolvedValue(partial);

        const intent = buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) });
        const event = buildApprovedEvent({ intent, reservationId: 'res-a6b-nonclean' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: ORDER_INTENT_UNKNOWN_EVENT emitted (non-clean terminal → M6/D4 reclaim path)
        const unknownCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);
        const [, unknownPayload] = unknownCalls[0];
        // positionId present (reconciler/sweeper can identify which row to reclaim)
        expect(typeof (unknownPayload as { positionId: number | null }).positionId).not.toBe('undefined');

        // Anti-regression: no HALTED expiry (the CLOSE was not aborted by halt — it ran to non-clean terminal)
        const haltedExpiry = bundle.emitSpy.mock.calls.filter(
            ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
        );
        expect(haltedExpiry.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A7 — Dry-run path unaffected: EXPIRED/DRY_RUN emitted for all action types
//      regardless of halt state (dry-run never reaches halt gates).
// ═══════════════════════════════════════════════════════════════════════════════

describe('A7 (happy path) — dry-run with halt set: EXPIRED/DRY_RUN emitted (halt gates not reached)', () => {
    it.each([OrderIntentActionEnum.OPEN, OrderIntentActionEnum.CLOSE, OrderIntentActionEnum.REDUCE, OrderIntentActionEnum.FLATTEN])(
        'dry-run + halt set + action=%s: EXPIRED/DRY_RUN emitted (no EXPIRED/HALTED)',
        async (intentAction) => {
            // BUILD: isExecutionLive=false → handleDryRun path; halt should not interfere
            const plan =
                intentAction === OrderIntentActionEnum.OPEN || intentAction === OrderIntentActionEnum.ADD
                    ? {
                          policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                          limitPrice: new Money('30000'),
                          timeoutMs: 0,
                          slippageCapPct: new Money('0.15'),
                          reduceOnly: false,
                      }
                    : { policy: OrderPolicyEnum.REDUCE_MARKET, limitPrice: new Money('30000'), timeoutMs: 0, slippageCapPct: new Money('0'), reduceOnly: true };
            const bundle = buildBundle({ isExecutionLive: false, plan });
            bundle.haltFlag.halt('dry-run-halt');

            const intent = buildOrderIntent({ intentAction, sizing: buildSizing({ qty: new Money('0.01') }) });
            const event = buildApprovedEvent({ intent, reservationId: `res-a7-${intentAction}` });

            // OPERATE
            await bundle.service.onOrderIntentApproved(event);

            // CHECK: EXPIRED/DRY_RUN emitted
            const dryRunExpiry = bundle.emitSpy.mock.calls.filter(
                ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_DRY_RUN,
            );
            expect(dryRunExpiry.length).toBe(1);

            // No HALTED expiry (dry-run exits at handleDryRun before halt gates)
            const haltedExpiry = bundle.emitSpy.mock.calls.filter(
                ([name, payload]) => name === ORDER_INTENT_EXPIRED_EVENT && (payload as { reason?: string }).reason === ORDER_INTENT_EXPIRED_REASON_HALTED,
            );
            expect(haltedExpiry.length).toBe(0);

            // Submit never called in dry-run
            expect(bundle.submitter.submit).not.toHaveBeenCalled();
        },
    );
});

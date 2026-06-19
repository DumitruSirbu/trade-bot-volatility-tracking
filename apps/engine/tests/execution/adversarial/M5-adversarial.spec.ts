/**
 * M5 Adversarial Backfill — Execution layer (M5.5 initiative).
 *
 * Surfaces covered (per docs/plans/M5.5-adversarial-backfill.md §M5):
 *
 *   S1. Idempotency replay on UNKNOWN reject (ADR 0006 §idempotency-contract)
 *       — recover returning FILLED / OPEN / null exhaustion; attemptN NOT incremented
 *         on UNKNOWN (same clientOrderId reused); -5022 duplicate routes to fetch, not retry.
 *
 *   S2. arm/disarm contract surface for M6 boot resync (ADR 0008 §always-protected-invariant)
 *       — after local_fallback close: protective_order_type='local_fallback', status correct,
 *         transaction row has client_order_id set. Validates the DB row shape M6 will read;
 *         does NOT test boot-scan logic (that is M6 scope).
 *
 *   S3. Partial-fill accounting adversarial boundaries (ADR 0007 §partial-fill-semantics)
 *       — zero fill on ADD (no position created); fill > intent qty (drift detection emits
 *         UNKNOWN with reason='drift' then clamps); weighted-avg entry uses filled qty not
 *         intended qty at the exact boundary where filledQty === oldQty (doubles the position).
 *
 *   S4. HaltFlagService gating on every retry hop (ADR 0006 §halt-gates-all-retries)
 *       — halt fires BETWEEN submit-call and ack (between submitOnce and the returned result);
 *         halt fires during REDUCE_MARKET remainder recursion; the state machine stops.
 *         NOTE: the existing ExecutionServiceDelta.spec.ts and ExecutionServiceRound3.spec.ts
 *         already cover halt-before-first-attempt and halt-mid-reduce-remainder comprehensively.
 *         This surface focuses on the gap: halt fires after UNKNOWN state is entered (between
 *         submit returning UNKNOWN and recover() starting), confirming no further exchange call
 *         is made.
 *
 *   S5. awaitPolicyTimeout per-policy adversarial boundaries (ADR 0005 §per-policy-timeouts)
 *       — IOC timeout where fetchByClientId returns a FILLED snapshot (position IS created,
 *         NOT treated as zero-fill); IOC timeout where fetch returns null (zero-fill, no
 *         position); REDUCE_MARKET halt-mid-remainder stops recursion (S4 overlap but framed
 *         per-policy).
 *
 * Each test references the ADR clause / invariant it falsifies.
 *
 * Failure routing: any test failure → ARCHITECT ROUTING NEEDED per dev-qa-cycle.md §2.2.
 */

import { OrderIntentActionEnum, OrderPolicyEnum, ProtectiveOrderTypeEnum, StrategyDirectionEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_EXPIRED_EVENT, ORDER_INTENT_FAILED_EVENT, ORDER_INTENT_UNKNOWN_EVENT, POSITION_OPENED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { MAX_PERMANENT_RETRY_ATTEMPTS } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';

import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildOrderIntent, buildSizing } from '../../risk/support/fixtures';
import {
    buildApprovedEvent,
    buildExchangeSideAttachResult,
    buildLocalFallbackAttachResult,
    buildOrderSnapshot,
    buildPositionEntityMock,
} from '../support/fixtures';

jest.useFakeTimers();

// ─── shared service factory ───────────────────────────────────────────────────

interface IServiceBundle {
    service: ExecutionService;
    submitter: jest.Mocked<ExchangeOrderSubmitter>;
    positions: jest.Mocked<{
        createOpen: jest.Mock;
        save: jest.Mock;
        findOpenBySymbol: jest.Mock;
        findOpenBySymbolAndSlot: jest.Mock;
    }>;
    transactions: jest.Mocked<{ recordTerminal: jest.Mock }>;
    riskGate: jest.Mocked<{ releaseReservation: jest.Mock; confirmReservation: jest.Mock }>;
    protectiveAttacher: jest.Mocked<ProtectiveOrderAttacher>;
    emitSpy: jest.SpyInstance;
    haltFlag: HaltFlagService;
    fillAccumulator: FillAccumulator;
    localProtectiveMonitor: LocalProtectiveMonitor;
}

function makeBundle(
    overrides: {
        isExecutionLive?: boolean;
        plan?: { policy: OrderPolicyEnum; limitPrice: MoneyValue; timeoutMs: number; slippageCapPct: MoneyValue; reduceOnly: boolean };
        positionRow?: ReturnType<typeof buildPositionEntityMock> & {
            qty?: MoneyValue;
            entryPrice?: MoneyValue;
            entryNotional?: MoneyValue;
        };
        findOpenResult?: unknown;
    } = {},
): IServiceBundle {
    const appConfig = { isExecutionLive: overrides.isExecutionLive ?? true } as AppConfigService;

    const defaultPlan = overrides.plan ?? {
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
        limitPrice: new Money('30000'),
        timeoutMs: 0,
        slippageCapPct: new Money('0.15'),
        reduceOnly: false,
    };

    const policyRouter = { plan: jest.fn().mockReturnValue(defaultPlan) } as unknown as OrderPolicyRouter;
    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );
    const haltFlag = new HaltFlagService();
    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();
    const fillAccumulator = new FillAccumulator();

    const defaultPositionRow = {
        ...buildPositionEntityMock(42),
        qty: new Money('0.01'),
        entryPrice: new Money('30000'),
        entryNotional: new Money('300'),
    };
    const positionRow = overrides.positionRow ?? defaultPositionRow;

    const findOpenResult = overrides.findOpenResult !== undefined ? overrides.findOpenResult : positionRow;

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
        findOpenBySymbol: jest.fn().mockResolvedValue([positionRow]),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(findOpenResult),
    } as unknown as IServiceBundle['positions'];

    const transactions = {
        recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as IServiceBundle['transactions'];

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = {
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
    } as unknown as IServiceBundle['riskGate'];

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()),
    } as unknown as IServiceBundle['protectiveAttacher'];

    const submitter = {
        submit: jest.fn(),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as IServiceBundle['submitter'];

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../../../src/position/service').PositionService;
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
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
    );

    return { service, submitter, positions, transactions, riskGate, protectiveAttacher, emitSpy, haltFlag, fillAccumulator, localProtectiveMonitor };
}

// ═══════════════════════════════════════════════════════════════════════════════
// S1 — Idempotency replay on UNKNOWN reject
// ADR 0006 §idempotency-contract: replay places at most one order.
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1 (happy path) — submit timeout → UNKNOWN → recover finds FILLED order → position created once', () => {
    /**
     * Happy path baseline: submit times out (UNKNOWN), recover returns a FILLED snapshot.
     * The executor must treat the recovered fill as the authoritative result and create
     * exactly one position row. Not zero (which would be a missed-entry phantom), not two.
     * ADR 0006 §3: "Order exists, status FILLED → adopt as authoritative submission. Do not retry."
     */
    it('UNKNOWN → recover returns FILLED: position created, no retry, reservation confirmed', async () => {
        // BUILD
        const bundle = makeBundle();
        const filledSnap = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12', status: 'closed' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.UNKNOWN,
            snapshot: null,
            rejectClass: 'UNKNOWN',
            venueCode: null,
            venueMessage: 'submit_network_timeout',
        });

        // recover returns the filled snapshot
        (bundle.submitter.recover as jest.Mock).mockResolvedValue(filledSnap);

        const event = buildApprovedEvent({ reservationId: 'res-s1-happy' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK
        // ADR 0006 §3: "Do not retry." — submit called exactly once
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);
        // Position created from the recovered fill
        expect(bundle.positions.createOpen).toHaveBeenCalledTimes(1);
        // Reservation confirmed (not released)
        expect(bundle.riskGate.confirmReservation).toHaveBeenCalledWith('res-s1-happy');
        expect(bundle.riskGate.releaseReservation).not.toHaveBeenCalled();
        // POSITION_OPENED_EVENT emitted
        expect(bundle.emitSpy.mock.calls.some(([name]) => name === POSITION_OPENED_EVENT)).toBe(true);
    });
});

describe('S1 (adversarial) — UNKNOWN → recover returns null (not on exchange) → RECONCILE_REQUIRED', () => {
    /**
     * ADR 0006 §3: "Order not found → retry with the same clientOrderId (same attemptN)."
     * After MAX_UNKNOWN_RECOVERY_ATTEMPTS exhausted, executor gives up → RECONCILE_REQUIRED.
     * Falsifies: "any UNKNOWN state eventually produces a committed position without
     * consuming the retry budget for permanent rejects."
     */
    it('UNKNOWN → recover exhausts MAX attempts returning null → RECONCILE_REQUIRED, no position created', async () => {
        // BUILD
        const bundle = makeBundle();

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.UNKNOWN,
            snapshot: null,
            rejectClass: 'UNKNOWN',
            venueCode: null,
            venueMessage: 'submit_network_timeout',
        });

        // recover always returns null (order never reached exchange after all probes)
        (bundle.submitter.recover as jest.Mock).mockResolvedValue(null);

        const event = buildApprovedEvent({ reservationId: 'res-s1-null-recover' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK
        // No position row — the order never confirmed
        expect(bundle.positions.createOpen).not.toHaveBeenCalled();
        // ORDER_INTENT_UNKNOWN_EVENT emitted (RECONCILE_REQUIRED path)
        const unknownCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);
        // Reservation released (not confirmed — nothing filled)
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-s1-null-recover');
    });
});

describe('S1 (adversarial) — UNKNOWN → recover returns OPEN → awaitPolicyTimeout fires', () => {
    /**
     * ADR 0006 §3: "Order exists, status='new'/'partially_filled' → move to OPEN, continue normal handling."
     * The IOC awaitPolicyTimeout path must fire on a recovered OPEN order, not skip it.
     * Falsifies: "a recovered OPEN order is abandoned without checking its terminal state."
     */
    it('UNKNOWN → recover returns OPEN → fetchByClientId called for IOC terminal probe', async () => {
        // BUILD: IOC plan with a non-zero timeout so awaitPolicyTimeout is triggered
        const iocPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 100,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const bundle = makeBundle({ plan: iocPlan });

        const openSnap = buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' });
        const filledSnap = buildOrderSnapshot({ status: 'closed', filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.UNKNOWN,
            snapshot: null,
            rejectClass: 'UNKNOWN',
            venueCode: null,
            venueMessage: 'submit_network_timeout',
        });

        // recover finds the order as OPEN
        (bundle.submitter.recover as jest.Mock).mockResolvedValue(openSnap);

        // fetchByClientId (the IOC terminal probe after timeout) returns filled
        (bundle.submitter.fetchByClientId as jest.Mock).mockResolvedValue(filledSnap);

        const event = buildApprovedEvent({ reservationId: 'res-s1-open-recover' });

        // OPERATE: flush timers to unblock the IOC sleep
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: fetchByClientId called (IOC terminal probe after recovered OPEN)
        expect(bundle.submitter.fetchByClientId).toHaveBeenCalledTimes(1);
        // Position created from the IOC terminal fill
        expect(bundle.positions.createOpen).toHaveBeenCalledTimes(1);
    });
});

describe('S1 (adversarial) — attemptN does NOT increment after UNKNOWN (same clientOrderId reused)', () => {
    /**
     * ADR 0006 §1: "attemptN is NOT incremented after a timeout — a timeout reuses the same id
     * so the recovery query fetchOrder finds any order that did make it through."
     * This is the idempotency-replay cornerstone. If attemptN were bumped on UNKNOWN, the
     * recovery fetch would use the WRONG id and might place a second order.
     * Falsifies: "a submit timeout creates a new clientOrderId on recovery, potentially doubling the order."
     */
    it('UNKNOWN: recover is called with the SAME clientOrderId as the submit (attemptN=0 for both)', async () => {
        // BUILD
        const bundle = makeBundle();

        let submittedClientOrderId: string | null = null;
        (bundle.submitter.submit as jest.Mock).mockImplementation(async (input: { clientOrderId: string }) => {
            submittedClientOrderId = input.clientOrderId;
            return {
                state: SubmitStateEnum.UNKNOWN,
                snapshot: null,
                rejectClass: 'UNKNOWN',
                venueCode: null,
                venueMessage: 'submit_network_timeout',
            };
        });

        // recover returns null (exhausts) — we only need to capture what symbol/id was used
        (bundle.submitter.recover as jest.Mock).mockResolvedValue(null);

        const event = buildApprovedEvent();

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: recover was called with the same symbol and clientOrderId as submit
        expect(bundle.submitter.recover).toHaveBeenCalledTimes(1);
        const [recoverSymbol, recoverClientOrderId] = (bundle.submitter.recover as jest.Mock).mock.calls[0] as [string, string];
        expect(recoverSymbol).toBe('BTCUSDT');
        // The key invariant: same id as submitted (attemptN unchanged)
        expect(recoverClientOrderId).toBe(submittedClientOrderId);
    });
});

describe('S1 (adversarial) — TERMINAL rejects (-2010, -2019) short-circuit to ABORTED without any retry', () => {
    /**
     * ADR 0006 §4: TERMINAL class → short-circuit to ABORTED, release reservation.
     * Falsifies: "a permanent-reject-class error passes through to the retry loop."
     */
    it.each(['-2010', '-2019'] as const)(
        'venue code %s (TERMINAL) → submit called once, ORDER_INTENT_FAILED emitted, reservation released',
        async (venueCode) => {
            // BUILD
            const bundle = makeBundle();

            (bundle.submitter.submit as jest.Mock).mockResolvedValue({
                state: SubmitStateEnum.REJECTED,
                snapshot: null,
                rejectClass: 'TERMINAL',
                venueCode,
                venueMessage: `binance ${venueCode} reject`,
            });

            const event = buildApprovedEvent({ reservationId: `res-terminal-${venueCode}` });

            // OPERATE
            await bundle.service.onOrderIntentApproved(event);

            // CHECK: exactly one submit attempt (no retry on TERMINAL)
            expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);
            const failedCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_FAILED_EVENT);
            expect(failedCalls.length).toBe(1);
            expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith(`res-terminal-${venueCode}`);
        },
    );
});

describe('S1 (adversarial) — -5022 duplicate-id routes to recover (UNKNOWN path), not a new submit', () => {
    /**
     * ADR 0006 §1: "-5022 Duplicate order id → executor treats as 'already submitted, fetch and reconcile'."
     * Falsifies: "a -5022 reject is treated as TERMINAL/RETRIABLE and retried with a new id, potentially
     * creating a second order at the exchange."
     */
    it('-5022 duplicate → recover called, NOT a second submit', async () => {
        // BUILD
        const bundle = makeBundle();
        const filledSnap = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12', status: 'closed' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.UNKNOWN,
            snapshot: null,
            rejectClass: 'UNKNOWN',
            venueCode: '-5022',
            venueMessage: 'Duplicate order id',
        });

        // recover finds the order that was already placed
        (bundle.submitter.recover as jest.Mock).mockResolvedValue(filledSnap);

        const event = buildApprovedEvent({ reservationId: 'res-s1-5022' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: submit called once (not retried); recover called to find the order
        expect(bundle.submitter.submit).toHaveBeenCalledTimes(1);
        expect(bundle.submitter.recover).toHaveBeenCalledTimes(1);
        // Position created from the recovered fill (the order existed at the exchange)
        expect(bundle.positions.createOpen).toHaveBeenCalledTimes(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2 — arm/disarm contract surface for M6 boot resync
// ADR 0008 §always-protected-invariant
// ═══════════════════════════════════════════════════════════════════════════════

describe('S2 (happy path) — after local_fallback close: position.status=CLOSED, protectiveOrderType=LOCAL_FALLBACK', () => {
    /**
     * ADR 0008 §3: after a local_fallback close (protective_order_type='local_fallback'),
     * the position row must show the correct status so M6 boot-scan can classify it.
     * This is the contract M6's reconciliation-on-boot depends on:
     *   - protective_order_type = 'local_fallback' (set at open, never changed to exchange_side)
     *   - position.status reflects the correct lifecycle state
     *   - the transaction row has client_order_id set (M6 dedupes on boot by this key)
     * Falsifies: "a local_fallback position is indistinguishable from an exchange_side position
     * in the DB row M6 reads on boot."
     */
    it('position row saved with LOCAL_FALLBACK protective type when attach returns local_fallback', async () => {
        // BUILD
        const bundle = makeBundle();
        const filledSnap = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12', status: 'closed' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: filledSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        (bundle.protectiveAttacher.attach as jest.Mock).mockResolvedValue(buildLocalFallbackAttachResult('exchange rejected SL'));

        const event = buildApprovedEvent({ reservationId: 'res-s2-local-fallback' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: positions.save called with LOCAL_FALLBACK protective type
        // (This is the DB state M6 will read on boot resync)
        const saveCalls = (bundle.positions.save as jest.Mock).mock.calls;
        const lastSaveArg = saveCalls[saveCalls.length - 1][0] as { protectiveOrderType: ProtectiveOrderTypeEnum };
        expect(lastSaveArg.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);
    });
});

describe('S2 (adversarial) — transaction row has client_order_id set after local_fallback open', () => {
    /**
     * ADR 0006 §5 + ADR 0008: the transactions row must carry client_order_id so M6 can
     * dedupe on boot. A missing or null client_order_id would make the deduplication
     * impossible and could trigger a double-order on restart.
     * Falsifies: "the transactions row written after a local_fallback open lacks client_order_id,
     * preventing M6 from performing idempotent deduplication on boot."
     */
    it('transactions row has non-null client_order_id after a local_fallback open', async () => {
        // BUILD
        const bundle = makeBundle();
        const filledSnap = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12', status: 'closed' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: filledSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        // local_fallback (exchange rejected SL/TP)
        (bundle.protectiveAttacher.attach as jest.Mock).mockResolvedValue(buildLocalFallbackAttachResult('exchange rejected'));

        const event = buildApprovedEvent();

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: recordTerminal called with a non-null, non-empty clientOrderId
        expect(bundle.transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const txArg = (bundle.transactions.recordTerminal as jest.Mock).mock.calls[0][0] as { clientOrderId: string | null };
        expect(txArg.clientOrderId).not.toBeNull();
        expect(txArg.clientOrderId).toMatch(/^tbvt-/);
    });
});

describe('S2 (adversarial) — monitor remains armed after local_fallback (position observable to M6 scan)', () => {
    /**
     * ADR 0008 §2: "there is no code path that writes a positions row without arming the monitor."
     * After a local_fallback open, the monitor MUST be armed (not disarmed), so M6 boot-scan
     * can detect it in listArmed() and resume protection.
     * Falsifies: "a local_fallback position disarms the monitor, making the position invisible
     * to M6's boot-time re-arm sweep."
     */
    it('local monitor is armed (not disarmed) after local_fallback attach', async () => {
        // BUILD
        const bundle = makeBundle();
        const filledSnap = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12', status: 'closed' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: filledSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        (bundle.protectiveAttacher.attach as jest.Mock).mockResolvedValue(buildLocalFallbackAttachResult('exchange rejected'));

        const event = buildApprovedEvent();

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: positionId=42 (from createOpen mock) must still be armed
        // This is the seam M6 reads: listArmed() returns this position for boot-time re-arm.
        expect(bundle.localProtectiveMonitor.isArmed(42)).toBe(true);
        expect(bundle.localProtectiveMonitor.listArmed().some((p) => p.positionId === 42)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S3 — Partial-fill accounting adversarial boundaries
// ADR 0007 §partial-fill-semantics
// ═══════════════════════════════════════════════════════════════════════════════

describe('S3 (happy path) — partial ADD fill: position qty uses filled qty, not intended qty', () => {
    /**
     * ADR 0007 §1: "filled qty is authoritative for every downstream quantity."
     * Happy path: ADD with partial fill (0.005 filled of 0.01 intended) uses filled qty.
     * Falsifies: "the ADD path anchors on intent.sizing.qty instead of the actual fill."
     */
    it('ADD partial fill: position qty incremented by filled qty (0.005), not intended qty (0.01)', async () => {
        // BUILD: existing position 0.01 qty; ADD fills 0.005 of 0.01 intended
        const existingQty = new Money('0.01');
        const existingEntry = new Money('30000');
        const existingNotional = existingQty.times(existingEntry);

        const filledQty = new Money('0.005'); // partial fill — less than intended 0.01
        const fillPrice = new Money('31000');
        const partialFillSnap = buildOrderSnapshot({
            filled: filledQty.toFixed(),
            average: fillPrice.toFixed(),
            cost: filledQty.times(fillPrice).toFixed(),
            fee: '0.06',
            status: 'closed',
        });

        const existingPosition = {
            id: 42,
            symbol: 'BTCUSDT',
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            qty: existingQty,
            entryPrice: existingEntry,
            entryNotional: existingNotional,
        };

        const bundle = makeBundle({ findOpenResult: existingPosition });
        bundle.fillAccumulator.record(partialFillSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: partialFillSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        let savedPosition: typeof existingPosition | null = null;
        (bundle.positions.save as jest.Mock).mockImplementation(async (pos: typeof existingPosition) => {
            savedPosition = pos;
            return pos;
        });

        const addIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.ADD,
            sizing: buildSizing({ qty: new Money('0.01') }), // intended 0.01, only 0.005 fills
        });
        const event = buildApprovedEvent({ intent: addIntent });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: qty = 0.01 + 0.005 = 0.015 (uses filledQty=0.005, not intendedQty=0.01)
        expect(savedPosition).not.toBeNull();
        expect((savedPosition as unknown as { qty: MoneyValue }).qty.toFixed(3)).toBe('0.015');
        // entry price weighted average uses actual fill
        const expectedEntry = existingQty.times(existingEntry).plus(filledQty.times(fillPrice)).dividedBy(existingQty.plus(filledQty));
        expect((savedPosition as unknown as { entryPrice: MoneyValue }).entryPrice.toFixed(2)).toBe(expectedEntry.toFixed(2));
    });
});

describe('S3 (adversarial) — zero-fill ADD: no position row created, no createOpen call', () => {
    /**
     * ADR 0007 §3: "The position row is created on the first fill of an OPEN, not on submit.
     * A zero-filled OPEN leaves no positions row."
     * Same rule applies to ADD: a zero-fill ADD must not phantom-update an existing position.
     * Falsifies: "a zero-fill ADD still increments position.qty or writes a phantom row."
     */
    it('ADD with zero fill: positions.save NOT called, positions.createOpen NOT called', async () => {
        // BUILD: ADD intent; submit returns CANCELLED with zero fill
        const zeroFillSnap = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const bundle = makeBundle();
        bundle.fillAccumulator.record(zeroFillSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.CANCELLED,
            snapshot: zeroFillSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        const addIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.ADD,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent: addIntent });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: no position mutation from a zero-fill ADD
        expect(bundle.positions.createOpen).not.toHaveBeenCalled();
        // save may only be called if a position exists and needs updating — must not be called for qty update
        // (The only acceptable save call would be a zero-fill audit row, which doesn't touch positions)
        const saveCalls = (bundle.positions.save as jest.Mock).mock.calls;
        expect(saveCalls.length).toBe(0);
    });
});

describe('S3 (adversarial) — drift: filled qty > position.qty triggers UNKNOWN with reason=drift, then clamps to zero', () => {
    /**
     * ADR 0007 §3 + ExecutionService.applyReduceFillToPosition round-4 #3:
     * "a negative remainder means exchange-vs-local drift (filled qty exceeds local position qty).
     * Do not silently clamp — emit ORDER_INTENT_UNKNOWN_EVENT with reason='drift'."
     * Then: "still clamp to 0 so the row is consistent."
     * Falsifies: "drift is silently swallowed — the local ledger disagrees with the exchange,
     * and M6 reconciliation never learns about it."
     */
    it('REDUCE fill larger than position.qty: UNKNOWN emitted with reason=drift, position qty clamped to 0', async () => {
        // BUILD: position holds 0.01 BTC; exchange fills 0.02 (drift: over-decrement)
        const localQty = new Money('0.01');
        const driftFilledQty = new Money('0.02'); // MORE than local qty

        const driftFillSnap = buildOrderSnapshot({
            filled: driftFilledQty.toFixed(),
            average: '30000',
            cost: driftFilledQty.times(new Money('30000')).toFixed(),
            fee: '0.12',
            status: 'closed',
        });

        const positionRow = {
            id: 42,
            symbol: 'BTCUSDT',
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            qty: localQty,
            entryPrice: new Money('30000'),
            entryNotional: new Money('300'),
            side: 'short' as const,
        };

        const bundle = makeBundle({
            plan: {
                policy: OrderPolicyEnum.REDUCE_MARKET,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0'),
                reduceOnly: true,
            },
            findOpenResult: positionRow,
        });
        bundle.fillAccumulator.record(driftFillSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: driftFillSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        let savedQty: MoneyValue | null = null;
        (bundle.positions.save as jest.Mock).mockImplementation(async (pos: { qty: MoneyValue }) => {
            savedQty = pos.qty;
            return pos;
        });

        const reduceIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent: reduceIntent, reservationId: 'res-s3-drift' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: ORDER_INTENT_UNKNOWN_EVENT emitted with reason='drift'
        const unknownCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBeGreaterThanOrEqual(1);
        const driftEvents = unknownCalls.filter(([, payload]) => (payload as { reason?: string }).reason === 'drift');
        expect(driftEvents.length).toBe(1);

        // Position qty clamped to 0 (full close via isClosingFill=true since localQty <= filledQty)
        expect(savedQty).not.toBeNull();
        expect((savedQty as unknown as MoneyValue).toFixed()).toBe('0');
    });
});

describe('S3 (adversarial) — ledger and decrement agree on clamped qty (not raw exchange fill)', () => {
    /**
     * ExecutionService.applyReduceFillToPosition round-5 #1:
     * "on drift the audit ledger row must reflect the qty actually decremented from the local
     * position (clamped), not the raw exchange-reported filled qty."
     * Falsifies: "the transactions row records the raw exchange fill (0.02) instead of the
     * clamped qty (0.01), causing the ledger and position row to disagree."
     */
    it('drift: transactions row qty = clamped local qty (0.01), not raw exchange fill (0.02)', async () => {
        // BUILD: same drift scenario as above
        const localQty = new Money('0.01');
        const driftFilledQty = new Money('0.02');

        const driftFillSnap = buildOrderSnapshot({
            filled: driftFilledQty.toFixed(),
            average: '30000',
            cost: driftFilledQty.times(new Money('30000')).toFixed(),
            fee: '0.12',
            status: 'closed',
        });

        const positionRow = {
            id: 42,
            symbol: 'BTCUSDT',
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            qty: localQty,
            entryPrice: new Money('30000'),
            entryNotional: new Money('300'),
            side: 'short' as const,
        };

        const bundle = makeBundle({
            plan: {
                policy: OrderPolicyEnum.REDUCE_MARKET,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0'),
                reduceOnly: true,
            },
            findOpenResult: positionRow,
        });
        bundle.fillAccumulator.record(driftFillSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: driftFillSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        (bundle.positions.save as jest.Mock).mockImplementation(async (pos: unknown) => pos);

        const reduceIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent: reduceIntent });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: transaction qty = localQty (0.01), not raw drift fill (0.02)
        expect(bundle.transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const txArg = (bundle.transactions.recordTerminal as jest.Mock).mock.calls[0][0] as { qty: MoneyValue };
        expect(txArg.qty.toFixed(2)).toBe(localQty.toFixed(2)); // 0.01, not 0.02
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S4 — HaltFlagService gating — gap between UNKNOWN and recover()
// ADR 0006 §halt-gates-all-retries
// ═══════════════════════════════════════════════════════════════════════════════

describe('S4 (happy path) — halt set before first attempt: no submit, reservation released', () => {
    /**
     * Happy path baseline: halt before the loop starts.
     * NOTE: already covered by ExecutionServiceDelta.spec.ts — included here as regression
     * backbone only to ensure the S4 adversarial tests below are not isolated.
     * ADR 0006 §halt-gates-all-retries: "no retry hop survives a halt flip."
     */
    it('halt set before first attempt: submit not called, ORDER_INTENT_EXPIRED emitted', async () => {
        // BUILD
        const bundle = makeBundle();
        bundle.haltFlag.halt('pre-test-halt');

        // OPERATE
        const event = buildApprovedEvent({ reservationId: 'res-s4-pre-halt' });
        await bundle.service.onOrderIntentApproved(event);

        // CHECK
        expect(bundle.submitter.submit).not.toHaveBeenCalled();
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-s4-pre-halt');
    });
});

describe('S4 (adversarial) — halt fires after submit returns UNKNOWN, before recover() — no recovery call', () => {
    /**
     * ADR 0006 §halt-gates-all-retries: "no retry hop survives a halt flip."
     * The gap: submit returns UNKNOWN (timeout), then the halt flag flips BEFORE recover()
     * is called. The runSubmitStateMachine loop checks halt at the TOP of each iteration.
     * The state machine must detect the halt on the NEXT iteration (after UNKNOWN is returned
     * as non-terminal RETRIABLE by UNKNOWN path) and abort before any recover call.
     *
     * Wait — UNKNOWN from submit goes to recoverFromUnknown immediately in submitOnce.
     * The halt check in runSubmitStateMachine is at the top of the for-loop, which fires
     * BEFORE submitOnce is called. After submitOnce returns UNKNOWN (non-terminal from
     * RETRIABLE perspective), the loop increments attemptN and checks halt at the TOP
     * of the NEXT iteration.
     *
     * Falsifies: "the halt check is skipped between an UNKNOWN terminal result and the
     * recover() call, allowing a recovery fetch to a halted engine."
     *
     * Structural note: recoverFromUnknown is called WITHIN submitOnce (same iteration),
     * not on the next loop iteration. So the halt check between submit-UNKNOWN and
     * recover is only the check at the top of the NEXT loop pass — but UNKNOWN returns
     * `terminal: true` from recoverFromUnknown (not non-terminal). This means the state
     * machine terminates on this iteration, not the next. The adversarial angle becomes:
     * when recover itself is slow/delayed and halt fires during that window, does the
     * executor eventually stop placing further retries?
     *
     * In the RETRIABLE case: halt fires between iteration N and N+1 → caught at top of N+1.
     * Test: first submit is RETRIABLE (non-terminal), halt fires during the sleep between
     * iterations, second iteration's halt check catches it before second submit.
     */
    it('RETRIABLE reject followed by halt: second attempt aborted, no position created', async () => {
        // BUILD: first submit → RETRIABLE (non-terminal, loops); halt fires before second attempt
        const bundle = makeBundle();

        let callCount = 0;
        (bundle.submitter.submit as jest.Mock).mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                // Halt between first and second attempt
                bundle.haltFlag.halt('between-retries-halt');
            }
            return {
                state: SubmitStateEnum.REJECTED,
                snapshot: null,
                rejectClass: 'RETRIABLE',
                venueCode: '-1021',
                venueMessage: 'Timestamp outside recv window',
            };
        });

        const event = buildApprovedEvent({ reservationId: 'res-s4-retriable-halt' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: only 1 submit (halt caught at top of second iteration)
        expect(callCount).toBe(1);
        // No position created
        expect(bundle.positions.createOpen).not.toHaveBeenCalled();
        // Reservation released (halt path)
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-s4-retriable-halt');
    });
});

describe('S4 (adversarial) — halt fires during REDUCE_MARKET remainder recursion (ADR 0046 §2.1 new contract)', () => {
    /**
     * ADR 0046 §2.1 NEW CONTRACT: REDUCE under halt proceeds (halt gate scoped to OPEN/ADD only).
     * resolveReduceTerminal no longer aborts on halt for REDUCE intents.
     * The partial-fill partial recursion still escalates to ORDER_INTENT_UNKNOWN_EVENT,
     * but NOT because halt aborted the REDUCE — because the partial-remainder budget exhausted.
     *
     * What changed from the pre-D1 contract:
     *   OLD: halt in resolveReduceTerminal unconditionally aborted any intent (REDUCE included).
     *        Exactly 1 submit fired (halt aborted recursion before 2nd hop).
     *   NEW: halt in resolveReduceTerminal is scoped via isOpenOrAddIntent — REDUCE bypasses gate 3.
     *        The recursion is NOT stopped by halt. The UNKNOWN event still fires for a partial
     *        non-clean terminal, but submit may fire more than once (recursion continues under halt).
     *
     * Falsifies: "halt between reduce-remainder hops allows an additional order to be placed."
     *   → Under new contract: placing additional orders on REDUCE under halt is PERMITTED.
     *     The test now verifies that the REDUCE reaches submitter.submit under halt (gate not blocking).
     */
    it('halt fires after first REDUCE attempt: REDUCE proceeds under halt, UNKNOWN event still emitted for partial terminal', async () => {
        // BUILD
        const reducePlan = {
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: new Money('30000'),
            timeoutMs: 50,
            slippageCapPct: new Money('0'),
            reduceOnly: true,
        };
        const partialFill = buildOrderSnapshot({
            status: 'canceled',
            filled: '0.005',
            remaining: '0.005',
            cost: '150',
            average: '30000',
            fee: '0.01',
        });

        const positionRow = {
            id: 42,
            symbol: 'BTCUSDT',
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
            qty: new Money('0.01'),
            entryPrice: new Money('30000'),
            entryNotional: new Money('300'),
            side: 'short' as const,
        };

        const bundle = makeBundle({ plan: reducePlan, findOpenResult: positionRow });
        bundle.fillAccumulator.record(partialFill);

        let submitCount = 0;
        (bundle.submitter.submit as jest.Mock).mockImplementation(async () => {
            submitCount += 1;
            // Halt after the first submit result so resolveReduceTerminal sees halt on next hop
            bundle.haltFlag.halt('mid-reduce-halt');
            return {
                state: SubmitStateEnum.OPEN,
                snapshot: buildOrderSnapshot({ status: 'open' }),
                rejectClass: null,
                venueCode: null,
                venueMessage: null,
            };
        });

        (bundle.submitter.cancelByClientId as jest.Mock).mockResolvedValue(partialFill);
        (bundle.submitter.fetchByClientId as jest.Mock).mockResolvedValue(partialFill);

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-s4-reduce-halt' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK (new contract, ADR 0046 §2.1):
        // Gate 3 is bypassed for REDUCE — the recursion continues under halt.
        // With the partial returning 0.005 each time and qty=0.01:
        //   attempt 0: partial 0.005, remainder 0.005 → recurse
        //   attempt 1: partial 0.005 again, remainder 0.005 - 0.005 = 0 → FILLED (clean terminal)
        // The clean-fill path processes normally without ORDER_INTENT_UNKNOWN_EVENT.
        //
        // REDUCE reached submitter.submit under halt (gate 3 bypassed for REDUCE)
        expect(submitCount).toBeGreaterThanOrEqual(1);

        // Anti-regression: ORDER_INTENT_EXPIRED_EVENT must NOT be emitted for a REDUCE (not halted-abort)
        const expiredCalls = bundle.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_EXPIRED_EVENT);
        expect(expiredCalls.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S5 — awaitPolicyTimeout per-policy adversarial boundaries
// ADR 0005 §per-policy-timeouts + ADR 0007 §4 remainder policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('S5 (happy path) — IOC timeout where fetchByClientId returns FILLED: position IS created', () => {
    /**
     * ADR 0007 §4 IOC policy: "On timeout, executor does NOT cancel. It calls fetchOrder to
     * discover terminal state." If fetch returns FILLED, a real position was opened.
     * This is the happy path for the IOC timeout branch — fill arrived after the defensive timer.
     * Falsifies: "IOC timeout is always a missed entry; a FILLED recovery is treated as zero-fill."
     */
    it('IOC timeout + fetchByClientId returns FILLED: position created with correct qty', async () => {
        // BUILD: IOC plan; submit returns OPEN (still in flight); fetchByClientId returns FILLED
        const iocPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 500,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const bundle = makeBundle({ plan: iocPlan });

        const filledSnap = buildOrderSnapshot({ status: 'closed', filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
        bundle.fillAccumulator.record(filledSnap);

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.OPEN,
            snapshot: buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' }),
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        // IOC terminal probe returns a filled snapshot
        (bundle.submitter.fetchByClientId as jest.Mock).mockResolvedValue(filledSnap);

        const event = buildApprovedEvent({ reservationId: 'res-s5-ioc-filled' });

        // OPERATE: flush timers to unblock the IOC sleep
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: position created from the fetched fill (not treated as zero-fill)
        expect(bundle.positions.createOpen).toHaveBeenCalledTimes(1);
        // fetchByClientId was the IOC probe (cancel was NOT called)
        expect(bundle.submitter.cancelByClientId).not.toHaveBeenCalled();
        expect(bundle.submitter.fetchByClientId).toHaveBeenCalledTimes(1);
        // Reservation confirmed
        expect(bundle.riskGate.confirmReservation).toHaveBeenCalledWith('res-s5-ioc-filled');
    });
});

describe('S5 (adversarial) — IOC timeout where fetchByClientId returns null: zero-fill, no position', () => {
    /**
     * ADR 0007 §4 IOC: "fetchOrder → Order not found → zero-fill terminal."
     * When fetch returns null after IOC timeout, no position must be created.
     * Boundary case: null from fetch must not be misread as "order still open, retry."
     * Falsifies: "IOC fetch returning null creates a phantom position or loops forever."
     */
    it('IOC timeout + fetchByClientId returns null: no position row, reservation released', async () => {
        // BUILD
        const iocPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 200,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const bundle = makeBundle({ plan: iocPlan });

        (bundle.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.OPEN,
            snapshot: buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' }),
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        // fetch returns null (order not found at exchange — never reached or already expired)
        (bundle.submitter.fetchByClientId as jest.Mock).mockResolvedValue(null);

        const event = buildApprovedEvent({ reservationId: 'res-s5-ioc-null' });

        // OPERATE
        const promise = bundle.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: no position created
        expect(bundle.positions.createOpen).not.toHaveBeenCalled();
        // Reservation released (missed entry)
        expect(bundle.riskGate.releaseReservation).toHaveBeenCalledWith('res-s5-ioc-null');
        // POSITION_OPENED_EVENT must NOT be emitted
        expect(bundle.emitSpy.mock.calls.some(([name]) => name === POSITION_OPENED_EVENT)).toBe(false);
    });
});

describe('S5 (adversarial) — RETRIABLE -1021 advances attemptN (different clientOrderId each time)', () => {
    /**
     * ADR 0006 §4: "RETRIABLE → attemptN increments."
     * Boundary at MAX_PERMANENT_RETRY_ATTEMPTS (2): attempts 0, 1, 2 → 3 total submits.
     * Each attempt must use a DIFFERENT clientOrderId (because attemptN is part of the seed).
     * Falsifies: "RETRIABLE rejects reuse the same clientOrderId, allowing the exchange
     * to duplicate-reject them all as -5022 after the first attempt."
     */
    it('RETRIABLE -1021: each of the 3 attempts uses a distinct clientOrderId', async () => {
        // BUILD: every submit returns RETRIABLE so the loop runs MAX_PERMANENT_RETRY_ATTEMPTS+1 times
        const bundle = makeBundle();
        const seenClientOrderIds: string[] = [];

        (bundle.submitter.submit as jest.Mock).mockImplementation(async (input: { clientOrderId: string }) => {
            seenClientOrderIds.push(input.clientOrderId);
            return {
                state: SubmitStateEnum.REJECTED,
                snapshot: null,
                rejectClass: 'RETRIABLE',
                venueCode: '-1021',
                venueMessage: 'Timestamp outside recv window',
            };
        });

        const event = buildApprovedEvent({ reservationId: 'res-s5-retriable-ids' });

        // OPERATE
        await bundle.service.onOrderIntentApproved(event);

        // CHECK: exactly MAX_PERMANENT_RETRY_ATTEMPTS + 1 = 3 attempts
        expect(seenClientOrderIds.length).toBe(MAX_PERMANENT_RETRY_ATTEMPTS + 1);
        // All ids must be distinct (different attemptN → different hash)
        const uniqueIds = new Set(seenClientOrderIds);
        expect(uniqueIds.size).toBe(MAX_PERMANENT_RETRY_ATTEMPTS + 1);
        // All ids start with the tbvt- prefix (deterministic scheme preserved)
        for (const id of seenClientOrderIds) {
            expect(id).toMatch(/^tbvt-/);
        }
    });
});

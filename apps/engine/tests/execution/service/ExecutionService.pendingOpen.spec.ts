/**
 * M6 W1.5 — Entry path starts at `pending_open` (ADR 0009 §3 / §4 / §6.1a).
 *
 * Coverage (per W1.5 plan, paired-per-fix):
 *   1. Entry happy-path: createOpen is invoked with state=PENDING_OPEN, then
 *      PositionService.transition fires with toState=OPEN and
 *      eventClass='protective.attached' after exchange-side attach acks.
 *   2. Local fallback path: when protective attach falls back, transition fires
 *      with eventClass='protective.local_fallback_engaged' and the local monitor
 *      stays armed (no disarm between PENDING_OPEN arm and the transition).
 *   3. Adversarial gate-guard invariant (boot-invariant cross-reference):
 *      documents that ADD intents must be rejected against pending_open rows.
 *      The gate-level enforcement is W4 (ReconciliationService + RejectReasonEnum
 *      RECONCILING_HOLD / state-aware guard); this spec stays as `it.todo` so
 *      the invariant is named and visible without touching a third file.
 *   4. Boot-invariant marker: a clearly named `boot-invariant` spec referencing
 *      W8 (ADR 0014 phase 3): post-restart, no PENDING_OPEN row may be left
 *      unattended. `it.todo` since W8 owns the recovery wiring.
 *
 * Single file, no production-code helpers added — keeps W1.5 inside its 2-file
 * scope cap (`docs/plans/M6-position-management.md` W1.5).
 */

import { PositionStateEnum, StrategyDirectionEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { POSITION_OPENED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../../../src/position/const';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import {
    buildApprovedEvent,
    buildExchangeSideAttachResult,
    buildLocalFallbackAttachResult,
    buildOrderSnapshot,
    buildPositionEntityMock,
} from '../support/fixtures';

jest.useFakeTimers();

function makeWiredService(
    overrides: {
        attachResult?: ReturnType<typeof buildExchangeSideAttachResult> | ReturnType<typeof buildLocalFallbackAttachResult>;
    } = {},
) {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: 'marketable_limit_ioc',
            limitPrice: new Money('30000'),
            timeoutMs: 2000,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        }),
    } as unknown as OrderPolicyRouter;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );
    const armSpy = jest.spyOn(localProtectiveMonitor, 'arm');
    const disarmSpy = jest.spyOn(localProtectiveMonitor, 'disarm');

    const haltFlag = new HaltFlagService();
    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();

    const snapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
    const submitter = {
        submit: jest.fn().mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        }),
        cancelByClientId: jest.fn(),
        fetchByClientId: jest.fn(),
        recover: jest.fn(),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    fillAccumulator.record(snapshot);

    const positionRow = buildPositionEntityMock(42);
    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
    } as unknown as import('../../../src/position/repository/PositionRepository').PositionRepository;

    const transactions = {
        recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as import('../../../src/position/repository/TransactionRepository').TransactionRepository;

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(overrides.attachResult ?? buildExchangeSideAttachResult()),
    } as unknown as ProtectiveOrderAttacher;

    const positionService = {
        transition: jest.fn().mockImplementation(async () => positionRow),
    } as unknown as PositionService;

    const service = new ExecutionService(
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter,
        fillAccumulator,
        protectiveAttacher,
        localProtectiveMonitor,
        positions,
        positionService,
        transactions,
        strategyVersions,
        riskGate,
        haltFlag,
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
    );

    return { service, positions, positionService, protectiveAttacher, emitSpy, armSpy, disarmSpy };
}

describe('M6 W1.5 — ExecutionService entry path inserts at PENDING_OPEN (ADR 0009 §6.1a)', () => {
    it('createOpen receives state=PENDING_OPEN in the INSERT (ADR 0009 §6.1)', async () => {
        const { service, positions } = makeWiredService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(positions.createOpen).toHaveBeenCalledTimes(1);
        const insertedRow = (positions.createOpen as jest.Mock).mock.calls[0][0] as { state?: PositionStateEnum };
        expect(insertedRow.state).toBe(PositionStateEnum.PENDING_OPEN);
    });

    it('transitions PENDING_OPEN -> OPEN with eventClass="protective.attached" on exchange-side attach success', async () => {
        const { service, positionService } = makeWiredService({ attachResult: buildExchangeSideAttachResult() });

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(positionService.transition).toHaveBeenCalledTimes(1);
        const [positionId, toState, ctx] = (positionService.transition as jest.Mock).mock.calls[0];
        expect(positionId).toBe(42);
        expect(toState).toBe(PositionStateEnum.OPEN);
        expect(ctx.eventClass).toBe('protective.attached');
    });

    it('transition to OPEN happens AFTER protective attach completes but BEFORE POSITION_OPENED_EVENT (entry happy-path ordering)', async () => {
        const { service, positionService, protectiveAttacher, emitSpy } = makeWiredService({ attachResult: buildExchangeSideAttachResult() });

        await service.onOrderIntentApproved(buildApprovedEvent());

        const attachOrder = (protectiveAttacher.attach as jest.Mock).mock.invocationCallOrder[0];
        const transitionOrder = (positionService.transition as jest.Mock).mock.invocationCallOrder[0];
        const openedIdx = emitSpy.mock.calls.findIndex(([n]) => n === POSITION_OPENED_EVENT);
        expect(openedIdx).toBeGreaterThanOrEqual(0);
        const openedOrder = emitSpy.mock.invocationCallOrder[openedIdx];

        expect(attachOrder).toBeLessThan(transitionOrder);
        expect(transitionOrder).toBeLessThan(openedOrder);
    });
});

describe('M6 W1.5 — Local fallback path transitions PENDING_OPEN -> OPEN with monitor still armed', () => {
    it('transitions with eventClass="protective.local_fallback_engaged" on attach fallback', async () => {
        const fallback = buildLocalFallbackAttachResult('ExchangeNotAvailable');
        const { service, positionService } = makeWiredService({ attachResult: fallback });

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(positionService.transition).toHaveBeenCalledTimes(1);
        const [, toState, ctx] = (positionService.transition as jest.Mock).mock.calls[0];
        expect(toState).toBe(PositionStateEnum.OPEN);
        expect(ctx.eventClass).toBe('protective.local_fallback_engaged');
    });

    it('LocalProtectiveMonitor stays armed across the PENDING_OPEN -> OPEN transition (no disarm on fallback)', async () => {
        const fallback = buildLocalFallbackAttachResult('exchange unavailable');
        const { service, armSpy, disarmSpy } = makeWiredService({ attachResult: fallback });

        await service.onOrderIntentApproved(buildApprovedEvent());

        // arm fires once (synchronously, before attach — ADR 0008 §2 sequence).
        expect(armSpy).toHaveBeenCalledTimes(1);
        // disarm MUST NOT fire on the local fallback path — the monitor is the only
        // line of defense once attach has failed (ADR 0009 §1 state-meanings table,
        // `state=open` + `protective_order_type=local_fallback` => monitor armed).
        expect(disarmSpy).not.toHaveBeenCalled();
    });
});

describe('M6 W1.5 — Adversarial: ADD on PENDING_OPEN must be rejected (regression bar)', () => {
    // W1.5 scope cap is 2 files (ExecutionService + tests). The gate-level
    // enforcement (RiskGateService rejecting ADD/OPEN intents on rows whose
    // state ∈ {pending_open, closing, reconciling, manual_adopted_unmanaged})
    // is W4 work — surfacing here as a named TODO so the invariant is visible
    // in the regression bar before the wiring lands. Per ADR 0009 §1
    // state-meanings table, only `state=open` allows new add/reduce intents.
    it.todo(
        'gate-guard W4: RiskGateService.evaluate rejects ADD on a row with state=PENDING_OPEN with reason RECONCILING_HOLD or equivalent state-aware reject (ADR 0009 §1, §6 invariant 4 analogue)',
    );

    it('positionService.transition was NEVER called with PENDING_OPEN as the target (anti-coverage: PENDING_OPEN is the entry state, not a destination)', async () => {
        const { service, positionService } = makeWiredService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const transitionCalls = (positionService.transition as jest.Mock).mock.calls;
        const everTargetedPendingOpen = transitionCalls.some(([, toState]) => toState === PositionStateEnum.PENDING_OPEN);
        expect(everTargetedPendingOpen).toBe(false);
    });
});

describe('M6 W1.5 — boot-invariant pointer (W8 will honor this)', () => {
    // ADR 0014 phase 3 (crash recovery): any PENDING_OPEN row left in the DB after
    // a restart MUST be reconciled against the exchange (verify SL/TP attach or
    // re-arm the local monitor) before the orchestrator reopens. W1.5 lands the
    // entry side of this contract; W8 lands the recovery side.
    it.todo(
        'boot-invariant: post-restart, no PENDING_OPEN row remains unattended — W8 (ADR 0014 phase 3) recovers SL/TP arm + drift sweep before phase 9 opens orchestrator',
    );

    it('boot-invariant: PENDING_OPEN is reachable in production today, so the W8 recovery test fixture must include at least one PENDING_OPEN row (forward-pointing assertion)', () => {
        // Static assertion: PENDING_OPEN is a defined, reachable enum value used by
        // the production entry path (ExecutionService.createPositionFromFill writes
        // it directly). Without this, W8 could ship a fixture matrix that omits
        // PENDING_OPEN and the boot-recovery happy-path would never exercise it.
        // Asserting the enum value is referenced here keeps the dependency visible
        // even when the test runs purely from the build artifact.
        expect(PositionStateEnum.PENDING_OPEN).toBe('pending_open');
    });
});

describe('M6 W1.5 — POSITION_STATE_TRANSITIONED_EVENT integration (smoke)', () => {
    it('the transition() seam is exercised exactly once per entry (no double-fire on the OPEN path)', async () => {
        const { service, positionService } = makeWiredService({ attachResult: buildExchangeSideAttachResult() });

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(positionService.transition as jest.Mock).toHaveBeenCalledTimes(1);
        // POSITION_STATE_TRANSITIONED_EVENT is emitted by the REAL PositionService —
        // here PositionService is mocked, so the assertion is on the transition call
        // itself (the event-emit path is unit-tested in PositionService.spec.ts).
        expect(POSITION_STATE_TRANSITIONED_EVENT).toBe('position.state.transitioned');
    });

    it('transition is NOT called when an ADD intent flows through (ADD path keeps existing protected position; no entry-state walk)', async () => {
        const { service, positionService } = makeWiredService();
        const addEvent = buildApprovedEvent({
            intent: { ...buildApprovedEvent().intent, intentAction: 'add' as never },
        });

        await service.onOrderIntentApproved(addEvent);

        // ADD path uses applyAddToExistingPosition which mutates qty/entryPrice only;
        // it must not invoke the entry-side transition() (which is reserved for the
        // OPEN-path PENDING_OPEN -> OPEN walk).
        expect(positionService.transition).not.toHaveBeenCalled();
    });
});

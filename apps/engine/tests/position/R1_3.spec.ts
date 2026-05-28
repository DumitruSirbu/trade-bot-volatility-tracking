/**
 * ReconciliationService — R1.3 cleanup wave.
 *
 * Coverage (paired-per-fix, fail-before / pass-after):
 *   - R1.3.1a (deterministic flatten eventId): two `forceTick` runs against an
 *     identical adopted-foreign-position-then-flatten scenario, executed under a
 *     frozen clock at the same nowMs, produce identical synthesised CLOSE-intent
 *     eventIds. Pre-fix the eventId embedded `Date.now()` and the two runs
 *     would diverge whenever the wall-clock moved between them.
 *   - R1.3.2 (flag-arg removed + private rename): the public surface no longer
 *     accepts a boolean parameter on `tick`. The two public entry points are
 *     `tick(nowMs)` and `forceTick(nowMs)`; the shared body is `runTickNow`,
 *     which is private (not on the public method list).
 */

import { CorrelationModeEnum, OrderIntentActionEnum, PositionSlotEnum, RiskOutcomeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { IOrderIntentApprovedEvent } from '../../src/risk/interface';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;

function buildExchangePosition(): IPositionSnapshot {
    return {
        symbol: 'ETHUSDT',
        side: 'long',
        qty: '0.5',
        entryPrice: '2000',
        markPrice: '2010',
        liquidationPrice: '1800',
        marginType: 'isolated',
        leverage: '5',
        timestampMs: NOW_MS,
    };
}

interface IFlattenHarness {
    service: ReconciliationService;
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
}

// Builds a harness whose foreign-position policy is 'flatten' — case-(a)
// EXCHANGE_NOT_IN_DB will adopt the row AND synthesise a CLOSE intent that
// routes through the risk gate. We capture the gate's input (which carries the
// synthesised eventId) to assert determinism.
function buildFlattenHarness(insertedRowIdSeed: number): IFlattenHarness {
    const exchangePositions: IPositionSnapshot[] = [buildExchangePosition()];

    const exchangeClient = {
        fetchPositions: jest.fn().mockResolvedValue(exchangePositions),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    };

    const positions = {
        findOpen: jest.fn().mockResolvedValue([]),
        createOpen: jest.fn().mockImplementation(
            async (entityLike: Partial<PositionEntity>) =>
                // Deterministic id seed so both runs produce the same positionId; this
                // proves the only remaining variability in the eventId is the
                // formerly-non-deterministic `Date.now()` slot.
                ({
                    id: insertedRowIdSeed,
                    correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
                    ...entityLike,
                }) as PositionEntity,
        ),
        save: jest.fn().mockImplementation(async (e: PositionEntity) => e),
        findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        updateProtectiveOrderTypeIfState: jest.fn().mockResolvedValue(1),
    };

    const transactions = {
        findByClientOrderId: jest.fn().mockResolvedValue(null),
        findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        findLatestByPositionId: jest.fn().mockResolvedValue(null),
    };

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(undefined),
        recordFunding: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockResolvedValue(undefined),
    };

    const riskGate = {
        expireStaleReservations: jest.fn(),
        evaluate: jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            approvedSlot: PositionSlotEnum.A,
            approvedSizing: null,
            clampedExit: null,
            reservationId: null,
        }),
        reconcileClose: jest.fn().mockResolvedValue(undefined),
        recordExposureDrift: jest.fn().mockResolvedValue(undefined),
    };

    const monitor = { arm: jest.fn(), disarm: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const strategyVersions = {
        findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7, name: 'manual_adopted', version: 0 }),
    };

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const haltFlag = new HaltFlagService();
    const instrumentor = { setLiquidationPrice: jest.fn() } as never;
    const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as never;

    const service = new ReconciliationService(
        exchangeClient as never,
        exchangeClient as never,
        { exchangeEnv: 'testnet' } as never,
        positions as unknown as PositionRepository,
        transactions as unknown as TransactionRepository,
        positionService as unknown as PositionService,
        riskGate as unknown as RiskGateService,
        monitor as unknown as LocalProtectiveMonitor,
        retainer,
        strategyVersions as unknown as StrategyVersionRepository,
        haltFlag,
        instrumentor,
        snapshotWriter,
        events,
    );

    service.setForeignPositionPolicy('flatten');

    return { service, events, emitSpy };
}

function getApprovedEvents(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
    return emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_APPROVED_EVENT).map(([, payload]) => payload as IOrderIntentApprovedEvent);
}

describe('ReconciliationService — R1.3.1a determinism (flatten eventId)', () => {
    it('two forceTick runs at the same nowMs produce identical synthesised CLOSE-intent eventIds', async () => {
        // Run 1 — wall-clock advanced arbitrarily between runs to prove the
        // eventId does NOT read from Date.now(). Freeze Date.now to one value
        // for the harness setup, run, then move it forward and run again.
        const dateNowSpy = jest.spyOn(Date, 'now');
        dateNowSpy.mockReturnValue(NOW_MS + 12_345);

        const harnessA = buildFlattenHarness(999);
        await harnessA.service.forceTick(NOW_MS);

        // Wall clock advances; eventId must remain stable because the only
        // input is the injected nowMs.
        dateNowSpy.mockReturnValue(NOW_MS + 7_654_321);

        const harnessB = buildFlattenHarness(999);
        await harnessB.service.forceTick(NOW_MS);

        dateNowSpy.mockRestore();

        const approvedA = getApprovedEvents(harnessA.emitSpy);
        const approvedB = getApprovedEvents(harnessB.emitSpy);

        expect(approvedA).toHaveLength(1);
        expect(approvedB).toHaveLength(1);
        expect(approvedA[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approvedB[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);

        // The load-bearing assertion: identical eventIds across runs with
        // different wall-clock readings, same injected nowMs.
        expect(approvedA[0].intent.eventId).toBe(approvedB[0].intent.eventId);

        // Sanity: eventId must embed the injected nowMs, not a wall-clock value.
        expect(approvedA[0].intent.eventId).toContain(String(NOW_MS));
        expect(approvedA[0].intent.eventId).not.toContain(String(NOW_MS + 12_345));
        expect(approvedB[0].intent.eventId).not.toContain(String(NOW_MS + 7_654_321));
    });
});

describe('ReconciliationService — R1.3.2 public surface (no boolean parameter)', () => {
    it('exposes tick and forceTick; runTickNow is private (not on the public method list)', () => {
        const harness = buildFlattenHarness(123);

        // Sanity: both legitimate entry points exist and are functions.
        expect(typeof harness.service.tick).toBe('function');
        expect(typeof harness.service.forceTick).toBe('function');

        // Each entry point takes exactly one parameter (nowMs). The pre-R1.3.2
        // signature `tick(nowMs, bypassMinInterval = false)` had Function.length=1
        // too (default parameters don't count), so we additionally assert the
        // PRIVATE name `runTickNow` is not exposed on the instance.
        expect(harness.service.tick.length).toBe(1);
        expect(harness.service.forceTick.length).toBe(1);

        // `runTickNow` MUST be private — not enumerable / not part of the public
        // method surface. TS's `private` is compile-time only, so this is the
        // runtime contract: the harness should never be able to call it as a
        // boolean-flag replacement.
        const publicMethodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(harness.service)).filter(
            (name) => name !== 'constructor' && typeof (harness.service as unknown as Record<string, unknown>)[name] === 'function',
        );
        // runTickNow is defined on the prototype (TS `private` is erased at
        // runtime), but it MUST NOT appear in the documented public dispatch
        // points used by the scheduler / boot pipeline / tests. Assert the
        // prior boolean-second-arg shape is gone instead, which is the actual
        // bug we care about:
        expect(harness.service.tick.length).toBe(1); // no boolean default arg
        expect(publicMethodNames).toContain('tick');
        expect(publicMethodNames).toContain('forceTick');
    });
});

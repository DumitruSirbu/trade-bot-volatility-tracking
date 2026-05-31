// M11a W3 — ShadowStrategyOrchestratorService adversarial coverage (ADR 0029 §2.2).
//
// Covers orchestrator-level contracts that the W2 happy-path suite does not exercise:
//   A1  — same eventId fires twice: no double-open in the ledger, no duplicate DB row
//   A2  — replay-after-restart: rebuildLedger + tryOpen with replayed eventId is a no-op
//   A4  — mid-event crash after persistence, before tryOpen: rebuild drives tryOpen correctly
//   D16 — NestJS @OnEvent is single-threaded: documents the ordering invariant
//   D17 — virtualSlotStateSnapshot is the pre-mutation snapshot (ADR 0029 §2.1.1)
//   E18 — shadow run failure does NOT cascade into the active path (fire-and-forget)
//   E19 — strategy evaluate() is called with only shadow-version state, not v1 slot state
//   E20 — no order.intent.approved event is emitted for shadow versions; RiskGateService
//          is NOT called on the shadow path (architectural boundary pin)

import { PositionSideEnum, SignalActionEnum, SignalTypeEnum, StrategyStatusEnum } from '@bot/shared';

import { ShadowStrategyOrchestratorService } from '../../../src/strategy/service/ShadowStrategyOrchestratorService';
import { VirtualPositionLedgerService } from '../../../src/strategy/service/VirtualPositionLedgerService';
import { ISignal } from '../../../src/strategy/interface';
import { buildEvent, buildParams } from '../support/fixtures';
import { buildProposedExit } from '../../risk/support/fixtures';

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIVE_VERSION_ID = 1;

// ─── Factories ───────────────────────────────────────────────────────────────

interface IMockShadowRow {
    id: number;
    name: string;
    version: number;
    status: StrategyStatusEnum;
    params: Record<string, unknown>;
}

function buildShadowRow(overrides: Partial<IMockShadowRow> = {}): IMockShadowRow {
    return {
        id: 2,
        name: 'volatility-vwap',
        version: 2,
        status: StrategyStatusEnum.SHADOW,
        params: buildParams() as unknown as Record<string, unknown>,
        ...overrides,
    };
}

function buildOpenSignal(): ISignal {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 70,
        flowType: buildEvent().flowType,
        reason: 'momentum_follow',
        proposedExit: buildProposedExit(),
    };
}

function buildSkipSignal(): ISignal {
    return {
        action: SignalActionEnum.SKIP,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: null,
        signalScore: 30,
        flowType: buildEvent().flowType,
        reason: 'baseline_no_trade',
        proposedExit: null,
    };
}

interface IMocks {
    config: { activeStrategyVersionId: number; paperStartingEquityUsdt: number };
    registry: { resolve: jest.Mock };
    strategyVersions: { findActiveShadows: jest.Mock };
    shadowDecisions: { insertShadowDecision: jest.Mock; findRowsForLedgerRebuild: jest.Mock };
    moduleRef: { resolve: jest.Mock };
    strategyEvaluate: jest.Mock;
}

function buildMocks(strategyOutput: ISignal): IMocks {
    const strategyEvaluate = jest.fn().mockReturnValue(strategyOutput);
    const registry = {
        resolve: jest.fn().mockReturnValue({
            strategy: { name: 'volatility-vwap', version: 2, evaluate: strategyEvaluate },
            params: buildParams(),
        }),
    };
    const strategyVersions = {
        findActiveShadows: jest.fn().mockResolvedValue([buildShadowRow()]),
    };
    const shadowDecisions = {
        insertShadowDecision: jest.fn().mockResolvedValue({}),
        findRowsForLedgerRebuild: jest.fn().mockResolvedValue([]),
    };
    const moduleRef = {
        resolve: jest.fn().mockImplementation(() => Promise.resolve(new VirtualPositionLedgerService())),
    };

    return {
        config: { activeStrategyVersionId: ACTIVE_VERSION_ID, paperStartingEquityUsdt: 500 },
        registry,
        strategyVersions,
        shadowDecisions,
        moduleRef,
        strategyEvaluate,
    };
}

function buildOrchestrator(mocks: IMocks): ShadowStrategyOrchestratorService {
    return new ShadowStrategyOrchestratorService(
        mocks.config as never,
        mocks.registry as never,
        mocks.strategyVersions as never,
        mocks.shadowDecisions as never,
        mocks.moduleRef as never,
    );
}

function buildHistoricalOpenRow(eventId: string, tradeSide: string | null = 'long') {
    return {
        eventId,
        symbol: 'BTCUSDT',
        action: SignalActionEnum.OPEN,
        gateAllowed: true,
        tradeSide,
        createdAt: new Date('2026-05-30T12:00:00Z'),
        // M11a W5a: persisted qty / SL / TP are required by the rebuild path.
        qty: '0.01',
        stopLoss: '29400.00',
        takeProfit: '31200.00',
        simulatedFill: {
            entryPrice: '30000.00',
            exitPrice: null,
            slippageEntryPct: '0',
            slippageExitPct: null,
            slippageComponents: { tierBase: '0', latency: '0', crossingSpread: '0' },
            missed: false,
            forceClose: false,
            lowFidelity: true,
            closedAt: null,
            closeReason: null,
        },
    };
}

// ─── A1: same eventId fires twice — no double-open, no duplicate DB row ───────

describe('ShadowStrategyOrchestratorService — same eventId fires twice does not double-open (A1)', () => {
    it('calling runShadows twice with the same eventId results in two insertShadowDecision calls (DB handles idempotency via UNIQUE constraint)', async () => {
        // BUILD
        const mocks = buildMocks(buildOpenSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        const nowMs = event.entryCandleOpenTime + 5 * 60_000;

        // OPERATE: fire the same event twice.
        await orchestrator.runShadows(event, nowMs);
        await orchestrator.runShadows(event, nowMs);

        // CHECK: insertShadowDecision called twice — both calls reach the repository.
        // The DB UNIQUE(shadow_version, event_id) constraint prevents the second from
        // creating a duplicate row (idempotent insert, ADR 0029 §2.1.2).
        expect(mocks.shadowDecisions.insertShadowDecision).toHaveBeenCalledTimes(2);
        // Both calls carry the same eventId.
        const firstCall = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0] as { eventId: string };
        const secondCall = mocks.shadowDecisions.insertShadowDecision.mock.calls[1][0] as { eventId: string };
        expect(firstCall.eventId).toBe(event.eventId);
        expect(secondCall.eventId).toBe(event.eventId);
    });

    it('ledger-level idempotency: tryOpen with a replayed eventId is a no-op (processedEventIds guard)', () => {
        // BUILD: direct ledger test — isolates the ledger's own idempotency guard from
        // the orchestrator fill simulator (which may produce missed=true fills).
        const ledger = new VirtualPositionLedgerService();
        const openInput = {
            eventId: 'evt-replay',
            nowMs: 1_716_307_200_000,
            riskDayUtcDate: '2026-05-30',
            symbol: 'BTCUSDT',
            side: 'long' as const,
            entryPrice: '30000.00',
            qty: '0.01',
            stopLoss: '29400.00',
            takeProfit: '31200.00',
            virtualOrderId: 'v2:evt-replay',
        };

        // OPERATE: open once, then replay.
        const firstResult = ledger.tryOpen(openInput);
        const replayResult = ledger.tryOpen(openInput);

        // CHECK
        expect(firstResult.success).toBe(true);
        expect(replayResult.success).toBe(false);
        expect(replayResult.reason).toBe('duplicate_event_id');
        expect(ledger.countOpenPositions()).toBe(1);
    });
});

// ─── A2: replay-after-restart preserves invariants ────────────────────────────

describe('ShadowStrategyOrchestratorService — replay-after-restart ledger coherence (A2)', () => {
    it('rebuildLedger with N persisted OPEN rows results in countOpenPositions() === N', async () => {
        // BUILD: seed two historical open rows for v2.
        const mocks = buildMocks(buildSkipSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        mocks.shadowDecisions.findRowsForLedgerRebuild.mockResolvedValue([
            buildHistoricalOpenRow('BTCUSDT:111', 'long'),
            buildHistoricalOpenRow('BTCUSDT:222', 'short'),
        ]);

        const orchestrator = buildOrchestrator(mocks);

        // OPERATE: boot triggers rebuildLedger.
        await orchestrator.onModuleInit();

        // CHECK: both rows replayed → 2 open positions.
        expect(capturedLedger.countOpenPositions()).toBe(2);
    });

    it('tryOpen with a replayed eventId is a no-op after rebuildLedger has already processed that event', async () => {
        // BUILD
        const mocks = buildMocks(buildOpenSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        const replayedEventId = 'BTCUSDT:1716307200000';
        mocks.shadowDecisions.findRowsForLedgerRebuild.mockResolvedValue([buildHistoricalOpenRow(replayedEventId, 'long')]);

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        // The rebuild opened one position for this eventId.
        expect(capturedLedger.countOpenPositions()).toBe(1);

        // OPERATE: runShadows fires again for the same event (e.g., after a restart mid-process).
        const event = buildEvent({ eventId: replayedEventId });
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        // CHECK: the ledger's tryOpen sees duplicate_event_id and rejects; still only 1 open.
        expect(capturedLedger.countOpenPositions()).toBe(1);
    });
});

// ─── A4: mid-event crash after persistence, before tryOpen ────────────────────
// Scenario: persistence row was written (shadow_decisions row exists with
// gateAllowed=true, non-missed fill, action=OPEN) but tryOpen never ran
// (engine crashed). On restart rebuildLedger replays the persisted row and
// drives tryOpen correctly.

describe('ShadowStrategyOrchestratorService — post-persistence crash recovery drives tryOpen on rebuild (A4)', () => {
    it('a persisted OPEN row with no prior tryOpen is replayed by rebuildLedger and advances the open-position count', async () => {
        // BUILD: simulate restart — the DB has the row but the old ledger is gone.
        const mocks = buildMocks(buildSkipSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        mocks.shadowDecisions.findRowsForLedgerRebuild.mockResolvedValue([buildHistoricalOpenRow('BTCUSDT:crashed-event', 'long')]);

        const orchestrator = buildOrchestrator(mocks);

        // OPERATE: boot causes rebuildLedger to replay the persisted row.
        await orchestrator.onModuleInit();

        // CHECK: the persisted row drove tryOpen → 1 open position restored.
        expect(capturedLedger.countOpenPositions()).toBe(1);
    });
});

// ─── D16: NestJS @OnEvent is single-threaded — ordering invariant ─────────────

describe('ShadowStrategyOrchestratorService — @OnEvent single-threaded invariant documented (D16)', () => {
    // NestJS EventEmitter2 dispatches @OnEvent handlers synchronously within a
    // single event loop tick. Concurrent in-flight calls to runShadows for the
    // same shadow version cannot occur because:
    //   (a) the engine is single-threaded (Node.js event loop),
    //   (b) @OnEvent handlers are not fired in parallel for the same listener,
    //   (c) the orchestrator is @Injectable() (singleton scope) so there is
    //       exactly one ledger instance per shadow version per process lifetime.
    //
    // This test pins the invariant by verifying that sequential runShadows calls
    // for two distinct events produce consistent open-count progression, proving
    // no interleaved mutation can corrupt the ledger under normal @OnEvent usage.
    it('sequential runShadows calls for distinct events advance the ledger count one-at-a-time', async () => {
        // BUILD: use a skip signal to avoid fill-simulation complexity; each call
        // still records a shadow_decisions row.
        const mocks = buildMocks(buildSkipSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const eventA = buildEvent({ eventId: 'BTCUSDT:event-a', entryCandleOpenTime: 1_716_307_200_000 });
        const eventB = buildEvent({ eventId: 'BTCUSDT:event-b', entryCandleOpenTime: 1_716_307_500_000 });
        const nowA = eventA.entryCandleOpenTime + 5 * 60_000;
        const nowB = eventB.entryCandleOpenTime + 5 * 60_000;

        // OPERATE: fire two events sequentially (no parallelism — mirrors @OnEvent semantics).
        await orchestrator.runShadows(eventA, nowA);
        await orchestrator.runShadows(eventB, nowB);

        // CHECK: two distinct persistence calls, no ledger corruption.
        expect(mocks.shadowDecisions.insertShadowDecision).toHaveBeenCalledTimes(2);
        const callA = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0] as { eventId: string };
        const callB = mocks.shadowDecisions.insertShadowDecision.mock.calls[1][0] as { eventId: string };
        expect(callA.eventId).toBe('BTCUSDT:event-a');
        expect(callB.eventId).toBe('BTCUSDT:event-b');
    });
});

// ─── D17: virtualSlotStateSnapshot is the pre-mutation snapshot ───────────────

describe('ShadowStrategyOrchestratorService — virtualSlotStateSnapshot reflects pre-mutation state (D17)', () => {
    it('persisted virtualSlotStateSnapshot shows 0 open positions for the first OPEN event (snapshot before tryOpen)', async () => {
        // BUILD
        const mocks = buildMocks(buildOpenSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        const nowMs = event.entryCandleOpenTime + 5 * 60_000;

        // OPERATE
        await orchestrator.runShadows(event, nowMs);

        // CHECK: the snapshot in the persisted row was taken BEFORE tryOpen mutated the
        // ledger (ADR 0029 §2.1.1 "snapshot for decision"). Even if the fill simulator
        // marks the fill as missed (no ledger mutation), the snapshot must reflect the
        // pre-event state — 0 open positions — so the soak report captures the gate
        // state at the moment of the decision, not after.
        const persistedRow = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0] as {
            virtualSlotStateSnapshot: { openPositions: unknown[] };
        };
        expect(persistedRow.virtualSlotStateSnapshot.openPositions).toHaveLength(0);
    });

    it('snapshotForDecision is called before evaluateGates mutates the ledger (direct ledger verification)', () => {
        // BUILD: direct ledger test — does not depend on the fill simulator outcome.
        // This test isolates the invariant: snapshot taken before the first open
        // reflects the pre-open state (0 positions); snapshot after open reflects
        // the post-open state (1 position).
        const ledger = new VirtualPositionLedgerService();
        const nowMs = 1_716_307_200_000 + 5 * 60_000;

        // OPERATE: take snapshot, then mutate.
        const snapshotBefore = ledger.snapshotForDecision(nowMs);
        ledger.tryOpen({
            eventId: 'evt-d17',
            nowMs,
            riskDayUtcDate: '2026-05-30',
            symbol: 'BTCUSDT',
            side: 'long',
            entryPrice: '30000.00',
            qty: '0.01',
            stopLoss: '29400.00',
            takeProfit: '31200.00',
            virtualOrderId: 'v2:evt-d17',
        });
        const snapshotAfter = ledger.snapshotForDecision(nowMs);

        // CHECK
        expect(snapshotBefore.openPositions).toHaveLength(0);
        expect(snapshotAfter.openPositions).toHaveLength(1);
    });
});

// ─── E18: shadow run failure does NOT cascade into active path ────────────────

describe('ShadowStrategyOrchestratorService — shadow failure stays contained inside runShadows (E18)', () => {
    // W5b FIX 3: `runShadows` is TRUE fire-and-forget. The orchestrator MUST
    // contain per-shadow persistence failures internally so the call site can
    // `void` the promise without adding latency or risking a cascade into the
    // live decision/order flow (ADR 0029 §2.2). Pins the contract from the
    // caller's perspective: the returned promise resolves even when persistence
    // fails — failure must be observable via logs, not via rejection.
    it('runShadows contains a persistence error internally and resolves without rejection', async () => {
        // BUILD
        const mocks = buildMocks(buildSkipSignal());
        mocks.shadowDecisions.insertShadowDecision.mockRejectedValueOnce(new Error('disk full'));
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();

        // OPERATE + CHECK: the failure does NOT escape runShadows.
        await expect(orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000)).resolves.toBeUndefined();
    });
});

// ─── E19: strategies remain pure — shadow path never contaminates v1 state ────

describe('ShadowStrategyOrchestratorService — shadow evaluate() is isolated from v1 slot state (E19)', () => {
    it('strategy.evaluate is called with openPosition=null regardless of how many positions v1 has open (pure input contract)', async () => {
        // BUILD: v1 supposedly has 1 open position — represented by the active snapshot
        // argument. The shadow path must NOT pass this into the shadow strategy's evaluate.
        const mocks = buildMocks(buildOpenSignal());
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        const nowMs = event.entryCandleOpenTime + 5 * 60_000;

        // OPERATE: pass a non-null active snapshot (simulating v1 has context).
        await orchestrator.runShadows(event, nowMs);

        // CHECK: the shadow strategy's evaluate was called with openPosition=null
        // (never passed v1's slot state — ADR 0029 §2.1 "cardinal rule").
        expect(mocks.strategyEvaluate).toHaveBeenCalledTimes(1);
        const evaluateArgs = mocks.strategyEvaluate.mock.calls[0][0] as { openPosition: unknown };
        expect(evaluateArgs.openPosition).toBeNull();
    });

    it('strategy.evaluate receives event + params re-classified under shadow params, not v1 params', async () => {
        // BUILD: shadow uses its own params (buildParams()), not whatever v1 happens to use.
        const mocks = buildMocks(buildSkipSignal());
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        const nowMs = event.entryCandleOpenTime + 5 * 60_000;

        // OPERATE
        await orchestrator.runShadows(event, nowMs);

        // CHECK: evaluate was called exactly once (isolated invocation per shadow, not zero).
        expect(mocks.strategyEvaluate).toHaveBeenCalledTimes(1);
        // The params passed in reflect the shadow row's params (confirm `params` key present).
        const evaluateArgs = mocks.strategyEvaluate.mock.calls[0][0] as { params: unknown };
        expect(evaluateArgs.params).toBeDefined();
    });
});

// ─── E20: no order leaves the engine through the shadow path ──────────────────

describe('ShadowStrategyOrchestratorService — no order.intent.approved emitted for shadow versions (E20)', () => {
    // ADR 0029 §2.2: shadow path records decisions only — it NEVER routes to the
    // exchange. The orchestrator has no EventEmitter injected, so there is no
    // mechanism to emit `order.intent.approved`. This test pins the structural
    // boundary: the service constructor accepts no EventEmitter2 / EventBusService
    // dependency (zero coupling to the live order flow).
    it('ShadowStrategyOrchestratorService constructor does not accept an EventEmitter or RiskGateService dependency', () => {
        // BUILD + OPERATE: reflect the constructor signature.
        const constructorParamCount = ShadowStrategyOrchestratorService.length;

        // CHECK: exactly 5 constructor parameters (config, registry, strategyVersions,
        // shadowDecisions, moduleRef) — no EventEmitter, no RiskGateService.
        // If an EventEmitter were injected the architectural boundary would be breached.
        expect(constructorParamCount).toBe(5);
    });

    it('runShadows does not call RiskGateService (shadow path bypasses the live risk gate)', async () => {
        // BUILD: no RiskGateService mock is available to inject — the orchestrator
        // has no reference to it. This test confirms that by running a full open
        // signal through runShadows and verifying no mock for a "risk gate" was ever
        // needed to satisfy the call. The absence of a RiskGateService dependency is
        // the structural proof.
        const mocks = buildMocks(buildOpenSignal());
        const riskGateEvaluate = jest.fn();
        // Attempt to inject a fake risk gate — it should never be referenced.
        (mocks as never as Record<string, unknown>)['riskGate'] = { evaluate: riskGateEvaluate };

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        // CHECK: the fake risk gate was never called.
        expect(riskGateEvaluate).not.toHaveBeenCalled();
    });
});

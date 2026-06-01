// M11a W2 (ADR 0029 §2.2) — paired unit specs for the shadow orchestrator.
// Each test pins ONE behavioural contract: each one fails on the inverse
// implementation (no shadow registration / live-path coupling / no fill
// simulator / no idempotent rebuild) and passes against the current service.
// Pure mocks — no DB, no real DI container; ModuleRef is stubbed.

import { PositionSideEnum, SignalActionEnum, SignalTypeEnum, StrategyStatusEnum } from '@bot/shared';

import { ShadowStrategyOrchestratorService } from '../../../src/strategy/service/ShadowStrategyOrchestratorService';
import { VirtualPositionLedgerService } from '../../../src/strategy/service/VirtualPositionLedgerService';
import { ISignal } from '../../../src/strategy/interface';
import { Money } from '../../../src/common/utils/money';
import { buildEvent, buildParams } from '../support/fixtures';
import { buildProposedExit } from '../../risk/support/fixtures';

const ACTIVE_VERSION_ID = 1;

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
        // W5c FIX 4: shadow now validates stop-side. For a LONG the stop must
        // sit BELOW entry (reconstructed at ~30450 from `buildEvent`).
        proposedExit: buildProposedExit({ stopLossPrice: new Money('29500'), takeProfitPrice: new Money('31000') }),
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
    // Each `moduleRef.resolve(VirtualPositionLedgerService)` returns a fresh
    // ledger — mirrors `Scope.TRANSIENT` semantics.
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

describe('ShadowStrategyOrchestratorService — onModuleInit', () => {
    // Pins: orchestrator excludes the active version and resolves only non-archived
    // shadows. Fails the inverse "resolves all rows" or "no exclusion filter" path.
    it('resolves shadows from findActiveShadows(activeId) and exposes the count', async () => {
        const mocks = buildMocks(buildSkipSignal());
        mocks.strategyVersions.findActiveShadows.mockResolvedValue([buildShadowRow({ id: 2, version: 2 }), buildShadowRow({ id: 3, version: 3 })]);
        const orchestrator = buildOrchestrator(mocks);

        await orchestrator.onModuleInit();

        expect(mocks.strategyVersions.findActiveShadows).toHaveBeenCalledWith(ACTIVE_VERSION_ID);
        expect(orchestrator.getResolvedShadowCount()).toBe(2);
    });

    // Pins: rebuild path queries the ShadowDecisionRepository on boot.
    // Fails an implementation that skips the cold-restart rebuild.
    it('queries findRowsForLedgerRebuild for every resolved shadow on boot', async () => {
        const mocks = buildMocks(buildSkipSignal());
        mocks.strategyVersions.findActiveShadows.mockResolvedValue([buildShadowRow({ id: 2, version: 2 }), buildShadowRow({ id: 3, version: 3 })]);
        const orchestrator = buildOrchestrator(mocks);

        await orchestrator.onModuleInit();

        expect(mocks.shadowDecisions.findRowsForLedgerRebuild).toHaveBeenCalledTimes(2);
        expect(mocks.shadowDecisions.findRowsForLedgerRebuild).toHaveBeenCalledWith('v2');
        expect(mocks.shadowDecisions.findRowsForLedgerRebuild).toHaveBeenCalledWith('v3');
    });
});

describe('ShadowStrategyOrchestratorService — runShadows persistence', () => {
    // Pins: every shadow version writes exactly one shadow_decisions row per event.
    // Fails an implementation that only records on the open branch.
    it('persists a shadow_decisions row for a SKIP signal with simulatedFill = null', async () => {
        const mocks = buildMocks(buildSkipSignal());
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        expect(mocks.shadowDecisions.insertShadowDecision).toHaveBeenCalledTimes(1);
        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.action).toBe(SignalActionEnum.SKIP);
        expect(row.simulatedFill).toBeNull();
        expect(row.shadowVersion).toBe('v2');
        expect(row.eventId).toBe(event.eventId);
    });

    // Pins: an OPEN signal with gate-allowed routes through HistoricalFillAdapter
    // and persists a non-null simulatedFill with entryPrice + slippage components.
    // Fails an implementation that bypasses the fill simulator (ADR 0029 §2.3
    // hard rule: raw decision-price PnL is forbidden — every shadow open MUST
    // produce an ISimulatedFill).
    it('persists a non-null simulatedFill for an OPEN signal that passes the virtual gate', async () => {
        const mocks = buildMocks(buildOpenSignal());
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        expect(mocks.shadowDecisions.insertShadowDecision).toHaveBeenCalledTimes(1);
        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.action).toBe(SignalActionEnum.OPEN);
        expect(row.gateAllowed).toBe(true);
        expect(row.simulatedFill).not.toBeNull();
        expect(row.simulatedFill.entryPrice).toBeDefined();
        // ADR 0029 §2.4: every shadow trade is lowFidelity until the depth-
        // aware extension lands.
        expect(row.simulatedFill.lowFidelity).toBe(true);
    });
});

describe('ShadowStrategyOrchestratorService — failure isolation', () => {
    // W5b FIX 3: shadow runs are TRUE fire-and-forget. `runShadows` contains
    // per-shadow failures internally so the caller can `void`-invoke without
    // adding live-path latency or risking a cascade. The contract: a
    // persistence failure resolves the returned promise (no rejection) and
    // is logged. Fails an implementation that re-throws into the caller.
    it('contains a persistence failure internally and resolves without rejection', async () => {
        const mocks = buildMocks(buildSkipSignal());
        mocks.shadowDecisions.insertShadowDecision.mockRejectedValueOnce(new Error('db down'));
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await expect(orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000)).resolves.toBeUndefined();
    });
});

describe('ShadowStrategyOrchestratorService — cold-restart rebuild', () => {
    // Pins replay-on-restart safety: an existing shadow_decisions OPEN row
    // (gate_allowed = true, non-missed simulatedFill) advances the ledger's
    // open count on boot. Fails an implementation that skips the rebuild or
    // ignores rows on replay.
    function buildHistoricalRow(tradeSide: string | null) {
        return {
            eventId: `BTCUSDT:1716307200000-${tradeSide ?? 'null'}`,
            symbol: 'BTCUSDT',
            action: SignalActionEnum.OPEN,
            gateAllowed: true,
            tradeSide,
            createdAt: new Date('2026-05-30T12:00:00Z'),
            // M11a W5a: persisted qty / SL / TP are required by the rebuild
            // path — rows without them are treated as legacy and skipped.
            qty: '0.01',
            stopLoss: '29000.00',
            takeProfit: '31000.00',
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

    it('replays a historical open row through tryOpen on boot', async () => {
        const mocks = buildMocks(buildSkipSignal());
        // Capture the ledger handed to this shadow so we can read its open
        // count after the rebuild.
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        mocks.shadowDecisions.findRowsForLedgerRebuild.mockResolvedValue([buildHistoricalRow('long')]);

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        expect(capturedLedger.countOpenPositions()).toBe(1);
    });

    // M11a W2.1 paired test: round-trip the persisted `trade_side` column —
    // a SHORT row rebuilt from shadow_decisions advances the ledger with
    // side='short'. FAILS before W2.1 (rebuild hardcoded 'long' fallback);
    // PASSES after (rebuild reads row.tradeSide).
    it('rebuilds a SHORT position from a persisted shadow_decision row via tryOpen with side=short', async () => {
        const mocks = buildMocks(buildSkipSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        mocks.shadowDecisions.findRowsForLedgerRebuild.mockResolvedValue([buildHistoricalRow('short')]);

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const snapshot = capturedLedger.snapshotForDecision(Date.UTC(2026, 4, 30, 13, 0, 0));
        expect(snapshot.openPositions).toHaveLength(1);
        expect(snapshot.openPositions[0].side).toBe('short');
    });
});

describe('ShadowStrategyOrchestratorService — persistShadowDecision tradeSide', () => {
    // M11a W2.1 paired test: confirms the insert payload carries `tradeSide`
    // so TypeORM persists it into the `trade_side` column. FAILS before W2.1
    // (the payload had a `side:` field that did not match the entity column
    // and was silently dropped); PASSES after (camelCase `tradeSide:` matches
    // the entity property name).
    it('passes tradeSide=short into insertShadowDecision for a SHORT open signal', async () => {
        const shortOpen: ISignal = {
            ...buildOpenSignal(),
            tradeSide: PositionSideEnum.SHORT,
        };
        const mocks = buildMocks(shortOpen);
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        expect(mocks.shadowDecisions.insertShadowDecision).toHaveBeenCalledTimes(1);
        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.tradeSide).toBe('short');
    });

    it('passes tradeSide=null into insertShadowDecision for a SKIP signal', async () => {
        const mocks = buildMocks(buildSkipSignal());
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.tradeSide).toBeNull();
    });
});

describe('ShadowStrategyOrchestratorService — W5c FIX 1 reverse-signal close ordering', () => {
    // W5c FIX 1 paired test: when the ledger already holds an open LONG for a
    // symbol and a fresh SHORT-OPEN event arrives, the reverse-close MUST fire
    // BEFORE `evaluateGates` so the new OPEN passes the
    // `max_open_positions: 1` gate. FAILS the pre-fix implementation (close
    // sat inside `if (shouldSimulateFill)` after the gate, so the gate
    // rejected the SHORT with `max_open_positions_reached` and the close
    // never ran).
    it('closes an opposite-side existing position BEFORE the gate so a SHORT-OPEN against an open LONG succeeds', async () => {
        const shortOpen: ISignal = {
            ...buildOpenSignal(),
            tradeSide: PositionSideEnum.SHORT,
            // SHORT requires stopLoss above entry (~30450) for FIX 4 validity.
            proposedExit: buildProposedExit({ stopLossPrice: new Money('31000'), takeProfitPrice: new Money('29500') }),
        };
        const mocks = buildMocks(shortOpen);
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        // Seed: a LONG already open on BTCUSDT under the gate's
        // max_open_positions:1 profile. Without the reverse-close, the gate
        // would reject the new SHORT.
        const event = buildEvent();
        const seedResult = capturedLedger.tryOpen({
            eventId: 'seed-evt',
            nowMs: event.entryCandleOpenTime,
            riskDayUtcDate: new Date(event.entryCandleOpenTime).toISOString().slice(0, 10),
            symbol: event.symbol,
            side: 'long',
            entryPrice: '30000',
            qty: '0.01',
            stopLoss: '29000',
            takeProfit: '31000',
            virtualOrderId: 'seed-vo',
        });
        expect(seedResult.success).toBe(true);
        expect(capturedLedger.countOpenPositions()).toBe(1);

        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        // The critical invariant pinned by FIX 1: the LONG was closed BEFORE
        // the gate, and the gate ALLOWED the new SHORT-OPEN (pre-fix the
        // gate would have rejected it with `max_open_positions_reached`).
        // We assert via the persisted row's gateAllowed=true so this test is
        // not coupled to whether `HistoricalFillAdapter` reports the SHORT
        // fill as missed (a separate, fixture-dependent concern).
        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.action).toBe(SignalActionEnum.OPEN);
        expect(row.gateAllowed).toBe(true);
        expect(row.rejectReason).toBeNull();
        expect(row.tradeSide).toBe('short');

        // And: the previously open LONG is gone (closed by the reverse-close
        // path before the gate ran). Pre-fix the LONG would still be open.
        const snapshot = capturedLedger.snapshotForDecision(event.entryCandleOpenTime + 5 * 60_000);
        const longs = snapshot.openPositions.filter((position) => position.side === 'long');
        expect(longs).toHaveLength(0);
    });

    // W5c FIX 1 paired test (no-churn): a LONG-OPEN against an already-open
    // LONG is NOT a reverse signal. The close path must NOT fire — the gate
    // simply rejects with `max_open_positions_reached` and the existing LONG
    // remains untouched. Guards against a regression that closes-and-reopens
    // same-side re-confirmations.
    it('does NOT close a same-side existing position on re-confirmation', async () => {
        const mocks = buildMocks(buildOpenSignal());
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        capturedLedger.tryOpen({
            eventId: 'seed-evt-same',
            nowMs: event.entryCandleOpenTime,
            riskDayUtcDate: new Date(event.entryCandleOpenTime).toISOString().slice(0, 10),
            symbol: event.symbol,
            side: 'long',
            entryPrice: '30000',
            qty: '0.02',
            stopLoss: '29000',
            takeProfit: '31000',
            virtualOrderId: 'seed-vo-same',
        });

        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        // Existing LONG untouched (still 0.02 qty), gate rejects new LONG.
        expect(capturedLedger.countOpenPositions()).toBe(1);
        const snapshot = capturedLedger.snapshotForDecision(event.entryCandleOpenTime + 5 * 60_000);
        expect(snapshot.openPositions[0].side).toBe('long');
        expect(snapshot.openPositions[0].qty).toBe('0.02');

        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.gateAllowed).toBe(false);
        expect(row.rejectReason).toBe('max_open_positions_reached');
    });
});

describe('ShadowStrategyOrchestratorService — W5c FIX 4 stop-side validation', () => {
    // W5c FIX 4 paired test: a LONG signal with `stopLoss > entry` is a
    // malformed strategy output. We must NOT call tryOpen (sizing with
    // `.abs()` would silently produce a position that "stops" by hitting
    // take-profit). Expectation: warn + persist a gate-allowed row with
    // null simulatedFill, ledger unchanged.
    it('skips the open and does NOT call tryOpen when a LONG has stopLoss > entry', async () => {
        const invalidLong: ISignal = {
            ...buildOpenSignal(),
            // Reverse: stop ABOVE entry (~30450) — invalid for a LONG.
            proposedExit: buildProposedExit({ stopLossPrice: new Money('31000'), takeProfitPrice: new Money('29500') }),
        };
        const mocks = buildMocks(invalidLong);
        const capturedLedger = new VirtualPositionLedgerService();
        mocks.moduleRef.resolve.mockResolvedValueOnce(capturedLedger);
        const tryOpenSpy = jest.spyOn(capturedLedger, 'tryOpen');

        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000);

        // Ledger never touched.
        expect(tryOpenSpy).not.toHaveBeenCalled();
        expect(capturedLedger.countOpenPositions()).toBe(0);

        // Row still persisted (audit footprint) but with null simulatedFill /
        // qty so a downstream PnL aggregator does not count it.
        const row = mocks.shadowDecisions.insertShadowDecision.mock.calls[0][0];
        expect(row.action).toBe(SignalActionEnum.OPEN);
        expect(row.simulatedFill).toBeNull();
        expect(row.qty).toBeNull();
    });
});

describe('ShadowStrategyOrchestratorService — W5c FIX 2 outer-rejection contract', () => {
    // W5c FIX 2 paired test: the call-site contract changed from `void` (silent
    // unhandledRejection on outer throws) to `.catch()` (logged). The
    // `runShadows` method itself still resolves without rejection for per-
    // shadow failures (W5b FIX 3 contract preserved). This test pins that
    // unchanged behaviour explicitly — fails an implementation that re-throws
    // a per-shadow persistence failure back into the caller.
    it('runShadows resolves (does not reject) when a per-shadow persistence failure happens', async () => {
        const mocks = buildMocks(buildSkipSignal());
        mocks.shadowDecisions.insertShadowDecision.mockRejectedValueOnce(new Error('db down'));
        const orchestrator = buildOrchestrator(mocks);
        await orchestrator.onModuleInit();

        const event = buildEvent();
        await expect(orchestrator.runShadows(event, event.entryCandleOpenTime + 5 * 60_000)).resolves.toBeUndefined();
    });
});

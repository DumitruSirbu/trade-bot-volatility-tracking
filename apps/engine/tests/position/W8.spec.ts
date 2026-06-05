/**
 * M6 W8 — EngineBootstrapService (ADR 0014).
 *
 * Coverage:
 *   - Gate guard: RECOVERY_IN_PROGRESS rejection before phase 9; opens after.
 *   - Each phase callable in isolation; ordering preserved by `boot()`.
 *   - Phase 4a: open_exposure rebuild = SUM(entry_notional WHERE non-closed AND correlation_mode != null).
 *   - Phase 4c: re-arm LOCAL_FALLBACK positions; skip EXCHANGE_SIDE; skip RECONCILING / MANUAL_ADOPTED_UNMANAGED.
 *   - Phase 4d: instrumentor seeded for every non-drift open position.
 *   - Phase 5: retainer rebuilt with state-matched reasons.
 *   - Phase 7: equity-drift alert when delta > tolerance; silent when within.
 *   - Phase 9: markRecoveryComplete called, gate flips ready.
 *   - boot() failure: phase exception aborts and does NOT flip the ready flag.
 *   - boot() idempotent: second call is a no-op.
 *   - Backtest determinism smoke: identical seeded state → identical post-boot in-memory state.
 */

import {
    CorrelationModeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    RejectReasonEnum,
    RetainReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';

import { Money, MoneyValue } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { AccountSnapshotEntity, PositionEntity } from '../../src/position/entity';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { AccountSnapshotWriter } from '../../src/position/service/AccountSnapshotWriter';
import { EngineBootstrapService } from '../../src/bootstrap/service/EngineBootstrapService';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { ReservationLedger } from '../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { SlotManager } from '../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../src/risk/service/StressHaltEvaluator';

const NOW_MS = 1_700_000_000_000;

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(NOW_MS - 60_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        stopLossPrice: new Money('29500'),
        takeProfitPrice: new Money('31000'),
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        ...overrides,
    } as PositionEntity;
}

interface IHarness {
    boot: EngineBootstrapService;
    positions: { findOpen: jest.Mock };
    recon: { forceTick: jest.Mock };
    monitor: jest.Mocked<Pick<LocalProtectiveMonitor, 'arm'>> & { arm: jest.Mock };
    instrumentor: { onPositionOpened: jest.Mock };
    retainer: SubscriptionRetainer;
    riskGate: {
        setOpenExposureFromBoot: jest.Mock;
        markRecoveryComplete: jest.Mock;
        isRecoveryReady: jest.Mock;
    };
    snapshotWriter: { writeNow: jest.Mock };
    snapshots: { findLatest: jest.Mock };
}

interface IHarnessOpts {
    positions?: PositionEntity[];
    latestSnapshot?: AccountSnapshotEntity | null;
    bootSnapshot?: AccountSnapshotEntity | null;
}

function buildHarness(opts: IHarnessOpts = {}): IHarness {
    const positions = { findOpen: jest.fn().mockResolvedValue(opts.positions ?? []) };
    const recon = { forceTick: jest.fn().mockResolvedValue({}) };
    const monitor = { arm: jest.fn() } as never;
    const instrumentor = { onPositionOpened: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const riskGate = {
        setOpenExposureFromBoot: jest.fn().mockResolvedValue(undefined),
        markRecoveryComplete: jest.fn(),
        isRecoveryReady: jest.fn(),
    };
    const bootSnapshotDefault: AccountSnapshotEntity = {
        id: 99,
        ts: new Date(NOW_MS),
        balance: new Money('1000'),
        equity: new Money('1000'),
        unrealizedPnl: new Money('0'),
        unrealizedPnlPrice: new Money('0'),
        unrealizedPnlFunding: new Money('0'),
    } as AccountSnapshotEntity;
    const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(opts.bootSnapshot ?? bootSnapshotDefault) };
    const snapshots = { findLatest: jest.fn().mockResolvedValue(opts.latestSnapshot ?? null) };

    const boot = new EngineBootstrapService(
        positions as unknown as PositionRepository,
        recon as unknown as ReconciliationService,
        monitor as unknown as LocalProtectiveMonitor,
        instrumentor as unknown as PositionInstrumentor,
        retainer,
        riskGate as unknown as RiskGateService,
        snapshotWriter as unknown as AccountSnapshotWriter,
        snapshots as unknown as AccountSnapshotRepository,
        // M11a R2d Item 3 (ADR 0032 §D12). PAPER branch of phase 2-3 needs
        // AppConfigService (env discriminator) + PaperReconciliationAdapter
        // (the in-memory-vs-persisted diff). LIVE/TESTNET branch in these
        // tests bypasses both — stub with a non-PAPER env so the branch is
        // structurally inert.
        { exchangeEnv: 'testnet' } as never,
        { forceTick: jest.fn().mockResolvedValue({ tickAtMs: 0, driftCount: 0, inMemoryCount: 0, persistedCount: 0 }) } as never,
    );

    return { boot, positions, recon, monitor, instrumentor, retainer, riskGate, snapshotWriter, snapshots };
}

// ─── gate guard (ADR 0014 §1, §9) ──────────────────────────────────────────

describe('RiskGateService.evaluate — RECOVERY_IN_PROGRESS guard (ADR 0014 §1, §9)', () => {
    function buildGate() {
        const ledger = new ReservationLedger();
        const positions = { findById: jest.fn().mockResolvedValue(null) };
        const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) };
        const events = { emit: jest.fn() };
        return new RiskGateService(
            ledger,
            new SlotManager(),
            new StressHaltEvaluator(),
            positions as never,
            riskState as never,
            events as never,
            { marketStressAutoResumeEnabled: false } as never,
        );
    }

    it('starts in recovery mode (isRecoveryReady === false on construction)', () => {
        const gate = buildGate();

        expect(gate.isRecoveryReady()).toBe(false);
    });

    it('rejects opening intents with RECOVERY_IN_PROGRESS before markRecoveryComplete', async () => {
        const gate = buildGate();
        const decision = await gate.evaluate({ intentAction: OrderIntentActionEnum.OPEN, symbol: 'BTCUSDT' } as never, {} as never);

        expect(decision.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(decision.rejectReason).toBe(RejectReasonEnum.RECOVERY_IN_PROGRESS);
    });

    // M6 R1.1.1 (ADR 0014 §1 revised): the RECOVERY_IN_PROGRESS reject is now
    // narrowed to OPENING intents only. CLOSE / REDUCE / FLATTEN must pass during
    // boot so case-(a) flatten, local-monitor breach-close, and operator
    // kill-switch all reach the executor before phase 9.
    it('R1.1.1: ADD intent is REJECTED during recovery (still an opening action)', async () => {
        const gate = buildGate();
        const decision = await gate.evaluate({ intentAction: OrderIntentActionEnum.ADD, symbol: 'BTCUSDT' } as never, {} as never);

        expect(decision.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(decision.rejectReason).toBe(RejectReasonEnum.RECOVERY_IN_PROGRESS);
    });

    it('R1.1.1: CLOSE intent PASSES during recovery (de-risking auto-approves)', async () => {
        const gate = buildGate();
        const decision = await gate.evaluate(
            { intentAction: OrderIntentActionEnum.CLOSE, symbol: 'BTCUSDT', sizing: { qty: new Money(0) } } as never,
            {} as never,
        );

        expect(decision.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('R1.1.1: REDUCE intent PASSES during recovery (de-risking auto-approves)', async () => {
        const gate = buildGate();
        const decision = await gate.evaluate(
            { intentAction: OrderIntentActionEnum.REDUCE, symbol: 'BTCUSDT', sizing: { qty: new Money(0) } } as never,
            {} as never,
        );

        expect(decision.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('R1.1.1: FLATTEN intent PASSES during recovery (kill-switch can reach executor)', async () => {
        const gate = buildGate();
        const decision = await gate.evaluate(
            { intentAction: OrderIntentActionEnum.FLATTEN, symbol: 'BTCUSDT', sizing: { qty: new Money(0) } } as never,
            {} as never,
        );

        expect(decision.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('flips to ready after markRecoveryComplete and accepts de-risking', async () => {
        const gate = buildGate();
        gate.markRecoveryComplete();

        expect(gate.isRecoveryReady()).toBe(true);

        const decision = await gate.evaluate(
            { intentAction: OrderIntentActionEnum.CLOSE, symbol: 'BTCUSDT', sizing: { qty: new Money(0) } } as never,
            {} as never,
        );

        // De-risking auto-approves (ADR 0004 §2); not RECOVERY_IN_PROGRESS.
        expect(decision.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('markRecoveryComplete is idempotent (second call is a no-op)', () => {
        const gate = buildGate();
        gate.markRecoveryComplete();
        gate.markRecoveryComplete();

        expect(gate.isRecoveryReady()).toBe(true);
    });
});

// ─── boot() — full pipeline ────────────────────────────────────────────────

describe('EngineBootstrapService.boot() — full pipeline ordering (ADR 0014 §1)', () => {
    it('runs phases in order: load → recon → caches → retainer → snapshot → orchestrator open', async () => {
        const harness = buildHarness({ positions: [buildPositionRow()] });
        const callOrder: string[] = [];
        harness.snapshots.findLatest.mockImplementation(async () => {
            callOrder.push('phase1');
            return null;
        });
        harness.recon.forceTick.mockImplementation(async () => {
            callOrder.push('phase2-3');
        });
        harness.positions.findOpen.mockImplementation(async () => {
            callOrder.push('phase4-load');
            return [buildPositionRow()];
        });
        harness.riskGate.setOpenExposureFromBoot.mockImplementation(async () => {
            callOrder.push('phase4a');
        });
        harness.monitor.arm.mockImplementation(() => {
            callOrder.push('phase4c');
        });
        harness.instrumentor.onPositionOpened.mockImplementation(() => {
            callOrder.push('phase4d');
        });
        harness.snapshotWriter.writeNow.mockImplementation(async () => {
            callOrder.push('phase7');
            return null;
        });
        harness.riskGate.markRecoveryComplete.mockImplementation(() => {
            callOrder.push('phase9');
        });

        await harness.boot.boot(NOW_MS);

        // Order is strictly: phase1, phase2-3, phase4-load, phase4a, phase4c, phase4d, phase7, phase9.
        // (phase5 doesn't appear because the retainer call is in-memory only.)
        expect(callOrder).toEqual(['phase1', 'phase2-3', 'phase4-load', 'phase4a', 'phase4c', 'phase4d', 'phase7', 'phase9']);
    });

    it('is idempotent: a second boot() call does nothing', async () => {
        const harness = buildHarness();

        await harness.boot.boot(NOW_MS);
        await harness.boot.boot(NOW_MS);

        expect(harness.recon.forceTick).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.markRecoveryComplete).toHaveBeenCalledTimes(1);
    });

    it('phase failure does NOT flip the ready flag (ADR §9 "no partial-ready")', async () => {
        const harness = buildHarness();
        harness.recon.forceTick.mockRejectedValueOnce(new Error('exchange offline'));

        await expect(harness.boot.boot(NOW_MS)).rejects.toThrow('exchange offline');

        // markRecoveryComplete never called → orchestrator stays closed
        expect(harness.riskGate.markRecoveryComplete).not.toHaveBeenCalled();
    });
});

// ─── per-phase isolation ──────────────────────────────────────────────────

describe('EngineBootstrapService — per-phase isolation (tests drive each phase directly)', () => {
    it('phase 1 reads the latest pre-crash account snapshot balance', async () => {
        const snapshot = { balance: new Money('1234.56') } as AccountSnapshotEntity;
        const harness = buildHarness({ latestSnapshot: snapshot });

        const result = await harness.boot.phase1LoadDurableState();

        expect(result.latestSnapshotBalance!.toFixed()).toBe('1234.56');
    });

    it('phase 1 returns null balance when there is no prior snapshot (first boot)', async () => {
        const harness = buildHarness({ latestSnapshot: null });

        const result = await harness.boot.phase1LoadDurableState();

        expect(result.latestSnapshotBalance).toBeNull();
    });

    it('phase 2-3 delegates to ReconciliationService.forceTick with nowMs', async () => {
        const harness = buildHarness();

        await harness.boot.phase2And3DriftSweep(NOW_MS);

        expect(harness.recon.forceTick).toHaveBeenCalledWith(NOW_MS);
    });

    it('phase 4a rebuilds open_exposure as SUM(entry_notional) over non-closed positions with non-null correlation_mode', async () => {
        const positions = [
            buildPositionRow({ id: 1, entryNotional: new Money('300'), correlationMode: CorrelationModeEnum.IDIOSYNCRATIC }),
            buildPositionRow({ id: 2, entryNotional: new Money('500'), correlationMode: CorrelationModeEnum.CORRELATED }),
            // Foreign adopted (excluded per ADR §4a).
            buildPositionRow({ id: 3, entryNotional: new Money('999'), state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, correlationMode: null }),
        ];
        const harness = buildHarness();

        await harness.boot.phase4aRebuildOpenExposure(positions, NOW_MS);

        expect(harness.riskGate.setOpenExposureFromBoot).toHaveBeenCalledTimes(1);
        const [exposure, nowMs] = harness.riskGate.setOpenExposureFromBoot.mock.calls[0];
        expect((exposure as MoneyValue).toFixed()).toBe('800'); // 300 + 500, foreign excluded
        expect(nowMs).toBe(NOW_MS);
    });

    it('phase 4a treats empty position list as zero exposure', async () => {
        const harness = buildHarness();

        await harness.boot.phase4aRebuildOpenExposure([], NOW_MS);

        const [exposure] = harness.riskGate.setOpenExposureFromBoot.mock.calls[0];
        expect((exposure as MoneyValue).toFixed()).toBe('0');
    });

    it('phase 4c re-arms LOCAL_FALLBACK positions; skips EXCHANGE_SIDE', () => {
        const localFallback = buildPositionRow({ id: 1, protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const exchangeSide = buildPositionRow({ id: 2, protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });
        const harness = buildHarness();

        harness.boot.phase4cRearmLocalMonitor([localFallback, exchangeSide]);

        expect(harness.monitor.arm).toHaveBeenCalledTimes(1);
        const armCall = harness.monitor.arm.mock.calls[0][0] as { positionId: number };
        expect(armCall.positionId).toBe(1);
    });

    it('phase 4c skips RECONCILING and MANUAL_ADOPTED_UNMANAGED positions', () => {
        const reconciling = buildPositionRow({ id: 1, state: PositionStateEnum.RECONCILING, protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const adopted = buildPositionRow({
            id: 2,
            state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        });
        const harness = buildHarness();

        harness.boot.phase4cRearmLocalMonitor([reconciling, adopted]);

        expect(harness.monitor.arm).not.toHaveBeenCalled();
    });

    it('phase 4d seeds instrumentor for non-drift positions', () => {
        const open = buildPositionRow({ id: 1, state: PositionStateEnum.OPEN });
        const closing = buildPositionRow({ id: 2, state: PositionStateEnum.CLOSING });
        const reconciling = buildPositionRow({ id: 3, state: PositionStateEnum.RECONCILING });
        const harness = buildHarness();

        harness.boot.phase4dSeedInstrumentor([open, closing, reconciling]);

        expect(harness.instrumentor.onPositionOpened).toHaveBeenCalledTimes(2);
        const seededIds = harness.instrumentor.onPositionOpened.mock.calls.map((c) => (c[0] as PositionEntity).id);
        expect(seededIds).toEqual([1, 2]);
    });

    it('phase 5 rebuilds the retainer with state-matched reasons (ADR 0011 §5)', () => {
        const open = buildPositionRow({ id: 1, symbol: 'BTCUSDT', state: PositionStateEnum.OPEN });
        const pending = buildPositionRow({ id: 2, symbol: 'ETHUSDT', state: PositionStateEnum.PENDING_OPEN });
        const closing = buildPositionRow({ id: 3, symbol: 'SOLUSDT', state: PositionStateEnum.CLOSING });
        const reconciling = buildPositionRow({ id: 4, symbol: 'LTCUSDT', state: PositionStateEnum.RECONCILING });
        const adopted = buildPositionRow({ id: 5, symbol: 'AVAXUSDT', state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED });
        const harness = buildHarness();

        harness.boot.phase5RebuildRetainer([open, pending, closing, reconciling, adopted]);

        expect(harness.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
        expect(harness.retainer.getReasonsFor('ETHUSDT').has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
        expect(harness.retainer.getReasonsFor('SOLUSDT').has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
        expect(harness.retainer.getReasonsFor('LTCUSDT').has(RetainReasonEnum.PENDING_RECONCILE)).toBe(true);
        expect(harness.retainer.getReasonsFor('AVAXUSDT').has(RetainReasonEnum.FOREIGN_ADOPTED)).toBe(true);
    });

    it('phase 7 calls writeNow with boot trigger; logs equity drift when delta > tolerance', async () => {
        const harness = buildHarness();
        const errorSpy = jest.spyOn(harness.boot['logger'], 'error').mockImplementation(() => undefined);
        harness.snapshotWriter.writeNow.mockResolvedValue({
            balance: new Money('1100'),
            equity: new Money('1100'),
        } as AccountSnapshotEntity);

        // Pre-crash balance differs by 100 > tolerance (1.00).
        await harness.boot.phase7BootSnapshot(NOW_MS, new Money('1000'));

        expect(harness.snapshotWriter.writeNow).toHaveBeenCalledWith(NOW_MS, 'boot');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('EQUITY DRIFT'));
    });

    it('phase 7 is SILENT when delta <= tolerance', async () => {
        const harness = buildHarness();
        const errorSpy = jest.spyOn(harness.boot['logger'], 'error').mockImplementation(() => undefined);
        harness.snapshotWriter.writeNow.mockResolvedValue({
            balance: new Money('1000.50'),
            equity: new Money('1000.50'),
        } as AccountSnapshotEntity);

        await harness.boot.phase7BootSnapshot(NOW_MS, new Money('1000'));

        // 0.50 delta <= 1.00 tolerance → no EQUITY DRIFT error log
        const driftCalls = errorSpy.mock.calls.filter((c) => String(c[0]).includes('EQUITY DRIFT'));
        expect(driftCalls).toHaveLength(0);
    });

    it('phase 7 skips drift comparison when there is no prior snapshot', async () => {
        const harness = buildHarness();
        const errorSpy = jest.spyOn(harness.boot['logger'], 'error').mockImplementation(() => undefined);

        await harness.boot.phase7BootSnapshot(NOW_MS, null);

        const driftCalls = errorSpy.mock.calls.filter((c) => String(c[0]).includes('EQUITY DRIFT'));
        expect(driftCalls).toHaveLength(0);
    });

    it('phase 9 calls riskGate.markRecoveryComplete', () => {
        const harness = buildHarness();

        harness.boot.phase9OpenOrchestrator();

        expect(harness.riskGate.markRecoveryComplete).toHaveBeenCalledTimes(1);
    });
});

// ─── boot() — orchestrator-closed-until-9 (gate integration smoke) ─────────

describe('EngineBootstrapService.boot() — gate flips ready ONLY after phase 9', () => {
    it('the gate.markRecoveryComplete call is the LAST significant boot action', async () => {
        const harness = buildHarness({ positions: [buildPositionRow()] });
        let markedReady = false;
        let calledAfterMark: string[] = [];

        harness.riskGate.markRecoveryComplete.mockImplementation(() => {
            markedReady = true;
        });
        // Track any subsequent calls that arrive after markRecoveryComplete.
        const wrap = (name: string, original: jest.Mock) => {
            original.mockImplementation(() => {
                if (markedReady) {
                    calledAfterMark.push(name);
                }
                return undefined;
            });
        };
        wrap('arm', harness.monitor.arm);
        wrap('onPositionOpened', harness.instrumentor.onPositionOpened);

        await harness.boot.boot(NOW_MS);

        expect(markedReady).toBe(true);
        expect(calledAfterMark).toEqual([]);
    });
});

// ─── determinism (ADR 0014 §8 smoke) ──────────────────────────────────────

describe('EngineBootstrapService — backtest-determinism smoke (ADR 0014 §8)', () => {
    it('two boots with identical seeded state produce identical post-boot in-memory snapshot', async () => {
        const positions = [
            buildPositionRow({ id: 1, symbol: 'BTCUSDT', entryNotional: new Money('300') }),
            buildPositionRow({ id: 2, symbol: 'ETHUSDT', state: PositionStateEnum.RECONCILING }),
        ];

        const h1 = buildHarness({ positions });
        const h2 = buildHarness({ positions });

        await h1.boot.boot(NOW_MS);
        await h2.boot.boot(NOW_MS);

        // Same exposure rebuild.
        const e1 = (h1.riskGate.setOpenExposureFromBoot.mock.calls[0][0] as MoneyValue).toFixed();
        const e2 = (h2.riskGate.setOpenExposureFromBoot.mock.calls[0][0] as MoneyValue).toFixed();
        expect(e1).toBe(e2);

        // Same retainer composition (Set comparison via sorted arrays).
        const r1 = [...h1.retainer.getRetainedSymbols()].sort();
        const r2 = [...h2.retainer.getRetainedSymbols()].sort();
        expect(r1).toEqual(r2);

        // Same monitor-arm call count + same instrumentor-seed call count.
        expect(h1.monitor.arm.mock.calls.length).toBe(h2.monitor.arm.mock.calls.length);
        expect(h1.instrumentor.onPositionOpened.mock.calls.length).toBe(h2.instrumentor.onPositionOpened.mock.calls.length);
    });
});

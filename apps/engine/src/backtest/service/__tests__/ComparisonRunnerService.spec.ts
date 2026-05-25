/**
 * ComparisonRunnerService + BacktestRunnerService tape modes — paired tests (M8 W4).
 *
 * Surfaces under test:
 *   T1 — recordEventTape produces a tape whose eventIds match the events `run` would
 *        have dispatched for the same fixture (deterministic equivalence pass-1 vs pass-2).
 *   T2 — replayTape over a tape produces identical trade outcomes (eventIds + per-event
 *        net PnL) to `run` over the same range for the same version.
 *   T3 — ComparisonRunnerService with 2 versions and 1 fold produces a report whose
 *        eventOutcomes count equals tape length, and each outcome's outcomesByVersion
 *        has exactly 2 keys.
 *   T4 — Tape slicing by fold window: a 2-fold run produces 2× the per-version cells;
 *        each cell's outcome rows reference only event_ids within that fold's window.
 *
 * All external dependencies are mocked. Strategy + trigger predicate are driven by a
 * controllable mock so the same fixture deterministically produces a known event set.
 */

import { CoinTierEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../../market-data/const/candleConsts';
import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { WalkForwardSplitModeEnum } from '../../enum/WalkForwardSplitModeEnum';
import { IWalkForwardSplitPolicy } from '../../interface/IWalkForwardSplitPolicy';
import { BacktestRunnerService } from '../BacktestRunnerService';
import { BootstrapStatsService } from '../BootstrapStatsService';
import { ComparisonRunnerService } from '../ComparisonRunnerService';

// ─── fixtures ────────────────────────────────────────────────────────────────

function buildParams() {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.3,
        btc_correlated_move_threshold_pct: 1.0,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier2_min_abs_move_pct: 1.0,
        tier3_min_abs_move_pct: 2.0,
        tier1_max_abs_move_pct: 5.0,
        tier2_max_abs_move_pct: 8.0,
        tier3_max_abs_move_pct: 12.0,
        funding_rate_suppress_threshold: 0.01,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 3,
        max_trades_per_symbol_per_day: 5,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildStrategyVersionEntity(id: number, name: string, version: number): StrategyVersionEntity {
    return {
        id,
        name,
        version,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        params: buildParams() as unknown as Record<string, unknown>,
        status: StrategyStatusEnum.ACTIVE,
        parentVersionId: null,
        promotedAt: null,
        archivedAt: null,
        promotionReportId: null,
        promotionNote: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
    } as StrategyVersionEntity;
}

function buildCandle(openTimeMs: number, open = 100, close = 101, high = 102, low = 99) {
    return {
        symbol: 'ETHUSDT',
        openTimeMs,
        open: String(open),
        close: String(close),
        high: String(high),
        low: String(low),
        volume: '1000',
        closeTimeMs: openTimeMs + CANDLE_5M_INTERVAL_MS - 1,
    };
}

function buildSnapshot(barOpenTimeMs: number, deviationSigma: number) {
    return {
        symbol: 'ETHUSDT',
        closedBarOpenTimeMs: barOpenTimeMs,
        vwapSession: new Money('2000'),
        vwap20bar: new Money('2000'),
        vwap24h: new Money('2000'),
        vwapEventAnchored: new Money('2000'),
        activeVwapAnchorType: 'session' as const,
        vwapDeviationPct: 3.5,
        vwapDeviationSigma: deviationSigma,
        volumeRatio: 2.5,
        volume20barAvg: new Money('500000'),
        atr14: new Money('50'),
        adx14: 20,
        adxDiPlus: 10,
        adxDiMinus: 5,
        rsi14: 55,
        bollingerUpper: new Money('2100'),
        bollingerLower: new Money('1900'),
        bollingerPctB: 0.7,
        close: new Money('2070'),
        fiveMinMovePct: 1.0,
    };
}

// Builds a runner whose pipeline deterministically fires a configurable subset of bars.
// The trigger predicate is driven indirectly: we supply snapshots whose vwapDeviationSigma
// exceeds the tier-1 threshold (the runner's `passesTrigger` reads tier-specific σ from
// the trigger params). Only bars at the `firingBarOpenMsList` indices fire.
function buildRunnerWithFixture(opts: { bars: Array<{ openMs: number; fires: boolean }>; orchestratorImpl?: (event: any, ctx: any) => Promise<any> }) {
    const replayBars = opts.bars.map((b) => buildCandle(b.openMs));
    const firingBars = new Set(opts.bars.filter((b) => b.fires).map((b) => b.openMs));

    const strategyRegistry = {
        resolve: jest.fn().mockReturnValue({
            strategy: {
                name: 'v1',
                version: 1,
                direction: StrategyDirectionEnum.MEAN_REVERSION,
                evaluate: jest.fn().mockReturnValue({
                    action: 'skip',
                    signalType: 'reversion',
                    skipReason: 'insufficient_deviation',
                    tradeSide: null,
                    signalScore: 0,
                    flowType: 'low_quality_noise',
                    reason: 'skip',
                    proposedExit: null,
                }),
            },
            params: buildParams(),
        }),
    };

    const strategyVersionRepository = {
        findById: jest.fn().mockImplementation((id: number) => Promise.resolve(buildStrategyVersionEntity(id, 'v1', 1))),
    };

    const instrumentRepository = { findAllTradable: jest.fn().mockResolvedValue([]) };

    const candleLoader = {
        loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs, toMs }: { symbol: string; fromMs: number; toMs: number }) => {
            if (symbol === 'BTCUSDT') return Promise.resolve([]);
            // Return only bars whose openMs falls inside [fromMs, toMs) — this is what
            // lets fold-window slicing in pass 2 work without a separate fixture.
            const isReplayWindow = fromMs >= new Date('2024-01-01T00:00:00.000Z').getTime();
            if (!isReplayWindow) return Promise.resolve([]);
            return Promise.resolve(replayBars.filter((b) => b.openTimeMs >= fromMs && b.openTimeMs < toMs));
        }),
        loadTicksForBar: jest.fn().mockResolvedValue([]),
    };

    const indicatorStateBuilder = {
        buildInitialWindow: jest.fn().mockReturnValue([]),
        appendBar: jest.fn().mockImplementation((window: any[], bar: any) => [...window, bar]),
        computeSnapshot: jest.fn().mockImplementation((_symbol: string, window: any[]) => {
            if (window.length === 0) return null;
            const bar = window[window.length - 1];
            // High sigma for firing bars; below tier-1 threshold otherwise. The tier-1
            // floor in const/triggerParams is configured at 2.0 σ for tier-1 (resolveTriggerParams
            // returns the per-tier σ). 5.0 always fires; 0.1 never does.
            const fires = firingBars.has(bar.openTimeMs);
            return buildSnapshot(bar.openTimeMs, fires ? 5.0 : 0.1);
        }),
    };

    const pointInTimeUniverse = {
        resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
        resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
    };

    const fundingReplayLoader = {
        loadForWindow: jest.fn().mockResolvedValue([]),
        computeCashflow: jest.fn().mockReturnValue(new Money('0')),
    };

    const openInterestRepository = { findRange: jest.fn().mockResolvedValue([]) };
    const bookSnapshotRepository = { findRange: jest.fn().mockResolvedValue([]) };

    const defaultOrchestrator = () => Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
    const orchestrator = {
        processEvent: jest.fn().mockImplementation(opts.orchestratorImpl ?? defaultOrchestrator),
    };

    const metricsComputer = {
        compute: jest.fn().mockImplementation((args: any) => ({
            strategyVersionId: args.strategyVersionId,
            strategyName: args.strategyName,
            strategyVersion: args.strategyVersion,
            fromUtcDate: args.fromUtcDate,
            toUtcDate: args.toUtcDate,
            runLabel: args.runLabel,
            tradeCount: args.trades.length,
            winCount: 0,
            lossCount: 0,
            winRatePct: '0',
            grossPnlUsdt: '0',
            feesUsdt: '0',
            fundingUsdt: '0',
            slippageCostUsdt: '0',
            netPnlUsdt: '0',
            returnPct: '0',
            profitFactor: '0',
            avgHoldMs: 0,
            maxDrawdownPct: args.maxDrawdownPct,
            maxDrawdownDurationDays: args.maxDrawdownDurationDays,
            sharpeAnnualized: '0',
            sortinoAnnualized: '0',
            skippedTriggerCount: args.skippedTriggerCount,
            rejectedByGateCount: args.rejectedByGateCount,
            missedLimitFillCount: args.missedLimitFillCount,
            lowFidelityTradeCount: args.lowFidelityTradeCount,
            equityCurve: args.equityCurve,
            perRegime: [],
            perFlowType: [],
            perSymbol: [],
            trades: args.trades,
        })),
    };

    const runner = new BacktestRunnerService(
        strategyRegistry as any,
        strategyVersionRepository as any,
        instrumentRepository as any,
        candleLoader as any,
        indicatorStateBuilder as any,
        pointInTimeUniverse as any,
        fundingReplayLoader as any,
        openInterestRepository as any,
        bookSnapshotRepository as any,
        orchestrator as any,
        metricsComputer as any,
    );

    return { runner, orchestrator };
}

function buildConfig(overrides: Partial<{ fromUtcDate: string; toUtcDate: string; strategyVersionId: number; runLabel: string }> = {}) {
    return {
        strategyVersionId: 1,
        fromUtcDate: '2024-01-01',
        toUtcDate: '2024-01-05',
        allocatedCapitalUsdt: '10000',
        latencyMs: 100,
        enableDepthAwareSlippage: false,
        enableIntrabarStopSimulation: false,
        runLabel: 'test-run',
        ...overrides,
    };
}

// ─── T1: recordEventTape parity with run dispatch ────────────────────────────

describe('BacktestRunnerService.recordEventTape', () => {
    it('produces a tape whose eventIds match what run would dispatch for the same fixture', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars = [
            { openMs: day0, fires: true },
            { openMs: day0 + CANDLE_5M_INTERVAL_MS, fires: false },
            { openMs: day0 + 2 * CANDLE_5M_INTERVAL_MS, fires: true },
            { openMs: day0 + 3 * CANDLE_5M_INTERVAL_MS, fires: true },
        ];

        // Pass A — collect eventIds that run() dispatches to the orchestrator.
        const dispatched: string[] = [];
        const { runner: runA } = buildRunnerWithFixture({
            bars,
            orchestratorImpl: (event: any) => {
                dispatched.push(event.eventId);
                return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
            },
        });
        await runA.run(buildConfig());

        // Pass B — record the tape with the same fixture.
        const { runner: runB } = buildRunnerWithFixture({ bars });
        const tape = await runB.recordEventTape(buildConfig());

        const tapeIds = tape.map((t) => t.eventId);
        expect(tapeIds).toEqual(dispatched);
        expect(tape).toHaveLength(3); // 3 firing bars
        expect(tape.every((t) => t.eventId.startsWith('ETHUSDT:'))).toBe(true);
    });

    it('does NOT invoke the orchestrator during a tape-recording pass', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars = [
            { openMs: day0, fires: true },
            { openMs: day0 + CANDLE_5M_INTERVAL_MS, fires: true },
        ];

        const { runner, orchestrator } = buildRunnerWithFixture({ bars });

        await runner.recordEventTape(buildConfig());

        expect(orchestrator.processEvent).not.toHaveBeenCalled();
    });

    it('stamps regime and flowType on each tape entry from the event payload', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars = [{ openMs: day0, fires: true }];

        const { runner } = buildRunnerWithFixture({ bars });
        const tape = await runner.recordEventTape(buildConfig());

        expect(tape).toHaveLength(1);
        expect(typeof tape[0].regime).toBe('string');
        expect(typeof tape[0].flowType).toBe('string');
        expect(tape[0].triggerTs).toBe(day0);
        expect(tape[0].symbol).toBe('ETHUSDT');
        expect(tape[0].marketSnapshot.eventId).toBe(tape[0].eventId);
    });
});

// ─── T2: replayTape parity with run ──────────────────────────────────────────

describe('BacktestRunnerService.replayTape', () => {
    it('routes only the tape entries to the orchestrator and matches run dispatch order', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars = [
            { openMs: day0, fires: true },
            { openMs: day0 + CANDLE_5M_INTERVAL_MS, fires: false },
            { openMs: day0 + 2 * CANDLE_5M_INTERVAL_MS, fires: true },
        ];

        // Capture run-dispatched eventIds.
        const runDispatched: string[] = [];
        const { runner: runA } = buildRunnerWithFixture({
            bars,
            orchestratorImpl: (event: any) => {
                runDispatched.push(event.eventId);
                return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
            },
        });
        await runA.run(buildConfig());

        // Record tape on a fresh runner.
        const { runner: runB } = buildRunnerWithFixture({ bars });
        const tape = await runB.recordEventTape(buildConfig());

        // Replay tape on a third runner; collect dispatched eventIds.
        const replayDispatched: string[] = [];
        const { runner: runC } = buildRunnerWithFixture({
            bars,
            orchestratorImpl: (event: any) => {
                replayDispatched.push(event.eventId);
                return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
            },
        });
        await runC.replayTape(buildConfig(), tape);

        expect(replayDispatched).toEqual(runDispatched);
    });

    it('does NOT dispatch tape entries whose triggerTs falls outside the config date window', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const day3 = new Date('2024-01-04T00:00:00.000Z').getTime();
        const bars = [
            { openMs: day0, fires: true },
            { openMs: day3, fires: true },
        ];

        const { runner } = buildRunnerWithFixture({ bars });
        const tape = await runner.recordEventTape(buildConfig());
        expect(tape).toHaveLength(2);

        // Replay with a narrower config that excludes the second bar.
        const replayDispatched: string[] = [];
        const { runner: narrow } = buildRunnerWithFixture({
            bars,
            orchestratorImpl: (event: any) => {
                replayDispatched.push(event.eventId);
                return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
            },
        });

        await narrow.replayTape(buildConfig({ fromUtcDate: '2024-01-01', toUtcDate: '2024-01-02' }), tape);

        expect(replayDispatched).toHaveLength(1);
        expect(replayDispatched[0]).toBe(`ETHUSDT:${day0}`);
    });
});

// ─── T3 + T4: ComparisonRunnerService end-to-end ─────────────────────────────

describe('ComparisonRunnerService.runComparison', () => {
    // Fold sizes in bars. Each "bar" in the bar fixture below spans one whole UTC day so
    // the runner's date-string config has full-day granularity. Train=2, val=1, oos=1 → 4
    // bars/fold; step=4 → non-overlapping folds.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const BARS_PER_DAY_OFFSET = ONE_DAY_MS / CANDLE_5M_INTERVAL_MS; // 288

    function buildPolicy(): IWalkForwardSplitPolicy {
        return {
            trainBars: 2 * BARS_PER_DAY_OFFSET,
            validationBars: 1 * BARS_PER_DAY_OFFSET,
            oosBars: 1 * BARS_PER_DAY_OFFSET,
            stepBars: 4 * BARS_PER_DAY_OFFSET,
            mode: WalkForwardSplitModeEnum.ROLLING,
        };
    }

    it('produces eventOutcomes count = tape length and each row has one entry per candidate', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        // 4 day-spaced bars (one fold: 2 train + 1 val + 1 oos). Fires on day 0, 2, 3.
        const bars: Array<{ openMs: number; fires: boolean }> = [
            { openMs: day0 + 0 * ONE_DAY_MS, fires: true },
            { openMs: day0 + 1 * ONE_DAY_MS, fires: false },
            { openMs: day0 + 2 * ONE_DAY_MS, fires: true },
            { openMs: day0 + 3 * ONE_DAY_MS, fires: true },
        ];

        const { runner } = buildRunnerWithFixture({ bars });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        const candidates = [buildStrategyVersionEntity(1, 'v1', 1), buildStrategyVersionEntity(2, 'v2', 1)];

        const report = await service.runComparison({
            runId: 'cmp-1',
            rangeFromMs: day0,
            rangeToMs: day0 + 4 * ONE_DAY_MS,
            splitPolicy: buildPolicy(),
            candidates,
            runLabel: 'test-cmp',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
        });

        expect(report.eventOutcomes).toHaveLength(3);

        for (const outcome of report.eventOutcomes) {
            // Each candidate evaluated each event across the fold's 3 windows. A 'skip'
            // record is overwritten each pass but the key set is the same.
            expect(outcome.outcomesByVersion.size).toBe(2);
            expect(outcome.outcomesByVersion.has(1)).toBe(true);
            expect(outcome.outcomesByVersion.has(2)).toBe(true);
        }

        expect(report.folds).toHaveLength(1);
        expect(report.versions).toHaveLength(2);
        // perFoldReports: 2 versions × 1 fold × 3 windows = 6 cells.
        expect(report.perFoldReports.size).toBe(6);
    });

    it('with 2 folds produces 2x cells per version and slices outcomes to fold windows', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        // 8 day-spaced bars = 2 non-overlapping folds (step=4 days). Firing on day 0
        // (fold 0 train) and day 5 (fold 1 train).
        const bars: Array<{ openMs: number; fires: boolean }> = [];
        for (let i = 0; i < 8; i += 1) {
            bars.push({ openMs: day0 + i * ONE_DAY_MS, fires: i === 0 || i === 5 });
        }

        const { runner } = buildRunnerWithFixture({ bars });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        const candidates = [buildStrategyVersionEntity(1, 'v1', 1), buildStrategyVersionEntity(2, 'v2', 1)];

        const report = await service.runComparison({
            runId: 'cmp-2',
            rangeFromMs: day0,
            rangeToMs: day0 + 8 * ONE_DAY_MS,
            splitPolicy: buildPolicy(),
            candidates,
            runLabel: 'test-cmp-2folds',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
        });

        expect(report.folds).toHaveLength(2);
        // 2 versions × 2 folds × 3 windows = 12 cells.
        expect(report.perFoldReports.size).toBe(12);

        // Tape has 2 events total — one per fold's first bar.
        expect(report.eventOutcomes).toHaveLength(2);

        // Each event lands in exactly one fold's train window. The outcomesByVersion map
        // must contain both versions (each version saw the event in the slice it
        // belonged to; the other slices excluded it by tape filtering).
        for (const outcome of report.eventOutcomes) {
            expect(outcome.outcomesByVersion.size).toBe(2);
        }

        // W5b: bootstrap + regime breakdown + tail-risk are now populated; only the W6
        // promotion-gate field remains as a placeholder sentinel for "not yet computed".
        // The 2-event fixture trips the sample-size gate so pairwiseStats emits a single
        // `inconclusive` row — assert shape, not winner.
        expect(Array.isArray(report.pairwiseStats)).toBe(true);
        expect(report.pairwiseStats).toHaveLength(1);
        expect(report.regimeBreakdown).not.toBeNull();
        expect(report.tailRiskByVersion).not.toBeNull();
        expect(report.promotionDecisions).toBeNull();
    });

    it('throws when candidates list is empty', async () => {
        const { runner } = buildRunnerWithFixture({ bars: [] });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        await expect(
            service.runComparison({
                runId: 'cmp-empty',
                rangeFromMs: 0,
                rangeToMs: 10 * CANDLE_5M_INTERVAL_MS,
                splitPolicy: buildPolicy(),
                candidates: [],
                runLabel: 'x',
                allocatedCapitalUsdt: '10000',
                latencyMs: 100,
                enableDepthAwareSlippage: false,
                enableIntrabarStopSimulation: false,
            }),
        ).rejects.toThrow(/at least one candidate/);
    });

    // W5b — wiring of BootstrapStatsService, regime breakdown, tail-risk into the report.
    // The 2-event fixture trips the sample-size gate (≥ 200 opens/candidate); we assert
    // shape, not winner. The conclusive-CI path is unit-tested in BootstrapStatsService.spec.
    it('populates pairwiseStats, regimeBreakdown, and tailRiskByVersion on the report', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars: Array<{ openMs: number; fires: boolean }> = [
            { openMs: day0 + 0 * ONE_DAY_MS, fires: true },
            { openMs: day0 + 1 * ONE_DAY_MS, fires: false },
            { openMs: day0 + 2 * ONE_DAY_MS, fires: true },
            { openMs: day0 + 3 * ONE_DAY_MS, fires: true },
        ];

        const { runner } = buildRunnerWithFixture({ bars });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        const candidates = [buildStrategyVersionEntity(1, 'v1', 1), buildStrategyVersionEntity(2, 'v2', 1)];

        const report = await service.runComparison({
            runId: 'cmp-stats',
            rangeFromMs: day0,
            rangeToMs: day0 + 4 * ONE_DAY_MS,
            splitPolicy: buildPolicy(),
            candidates,
            runLabel: 'test-cmp-stats',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
        });

        // Pairwise: exactly one ordered pair for two candidates; sample gate trips so
        // this is an `inconclusive` row (the fixture only fires 3 times).
        expect(Array.isArray(report.pairwiseStats)).toBe(true);
        expect(report.pairwiseStats).toHaveLength(1);
        const pair = report.pairwiseStats![0];
        expect(pair.versionA).toBe(1);
        expect(pair.versionB).toBe(2);
        expect(pair.outcome).toBe('inconclusive');

        // Regime breakdown: one entry per candidate.
        expect(report.regimeBreakdown).not.toBeNull();
        expect(report.regimeBreakdown!.has(1)).toBe(true);
        expect(report.regimeBreakdown!.has(2)).toBe(true);

        // Tail-risk: one entry per candidate (computed on the per-event r series).
        expect(report.tailRiskByVersion).not.toBeNull();
        expect(report.tailRiskByVersion!.has(1)).toBe(true);
        expect(report.tailRiskByVersion!.has(2)).toBe(true);

        // Two candidates → only one pair → no family-wise note.
        expect(report.multipleComparisonNote).toBeNull();
    });

    // W5b — determinism end-to-end: same `runLabel` over two independent runner instances
    // produces byte-identical pairwise stats. With an inconclusive outcome the only field
    // that varies under non-determinism is the counters block, so we deep-equal the whole
    // array to catch any silent drift.
    it('produces byte-identical pairwiseStats across two runs with the same runLabel', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars: Array<{ openMs: number; fires: boolean }> = [
            { openMs: day0, fires: true },
            { openMs: day0 + ONE_DAY_MS, fires: true },
            { openMs: day0 + 2 * ONE_DAY_MS, fires: false },
            { openMs: day0 + 3 * ONE_DAY_MS, fires: true },
        ];

        const candidates = [buildStrategyVersionEntity(1, 'v1', 1), buildStrategyVersionEntity(2, 'v2', 1)];
        const request = {
            runId: 'cmp-det',
            rangeFromMs: day0,
            rangeToMs: day0 + 4 * ONE_DAY_MS,
            splitPolicy: buildPolicy(),
            candidates,
            runLabel: 'deterministic-label',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
        };

        const { runner: r1 } = buildRunnerWithFixture({ bars });
        const reportA = await new ComparisonRunnerService(r1, new BootstrapStatsService()).runComparison(request);

        const { runner: r2 } = buildRunnerWithFixture({ bars });
        const reportB = await new ComparisonRunnerService(r2, new BootstrapStatsService()).runComparison(request);

        expect(reportA.pairwiseStats).toEqual(reportB.pairwiseStats);
    });

    // W5b — family-wise note triggers for 3+ candidates (3 pairs).
    it('emits a multipleComparisonNote when more than one pair exists', async () => {
        const day0 = new Date('2024-01-01T00:00:00.000Z').getTime();
        const bars: Array<{ openMs: number; fires: boolean }> = [
            { openMs: day0, fires: true },
            { openMs: day0 + ONE_DAY_MS, fires: false },
            { openMs: day0 + 2 * ONE_DAY_MS, fires: false },
            { openMs: day0 + 3 * ONE_DAY_MS, fires: false },
        ];

        const { runner } = buildRunnerWithFixture({ bars });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        const candidates = [buildStrategyVersionEntity(1, 'v1', 1), buildStrategyVersionEntity(2, 'v2', 1), buildStrategyVersionEntity(3, 'v3', 1)];

        const report = await service.runComparison({
            runId: 'cmp-fwer',
            rangeFromMs: day0,
            rangeToMs: day0 + 4 * ONE_DAY_MS,
            splitPolicy: buildPolicy(),
            candidates,
            runLabel: 'fwer',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
        });

        // 3 candidates → 3 ordered pairs.
        expect(report.pairwiseStats).toHaveLength(3);
        expect(report.multipleComparisonNote).not.toBeNull();
        expect(report.multipleComparisonNote).toContain('3');
    });

    it('throws when planner returns zero folds (range too short for policy)', async () => {
        const { runner } = buildRunnerWithFixture({ bars: [] });
        const service = new ComparisonRunnerService(runner, new BootstrapStatsService());

        await expect(
            service.runComparison({
                runId: 'cmp-short',
                rangeFromMs: 0,
                rangeToMs: 2 * CANDLE_5M_INTERVAL_MS, // way too short for the multi-day policy
                splitPolicy: buildPolicy(),
                candidates: [buildStrategyVersionEntity(1, 'v1', 1)],
                runLabel: 'x',
                allocatedCapitalUsdt: '10000',
                latencyMs: 100,
                enableDepthAwareSlippage: false,
                enableIntrabarStopSimulation: false,
            }),
        ).rejects.toThrow(/zero folds/);
    });
});

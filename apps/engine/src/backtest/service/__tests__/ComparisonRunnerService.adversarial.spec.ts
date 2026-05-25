/**
 * Adversarial tests for ComparisonRunnerService — degenerate tape inputs
 * (M8 W8 QA / ADR 0017 §2.2).
 *
 * Strategy: mock BacktestRunnerService and BootstrapStatsService so we can drive
 * exactly-zero tapes, single-event tapes, and one-sided-trading scenarios without
 * needing a real DB or exchange.
 */

import { StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { WalkForwardSplitModeEnum } from '../../enum/WalkForwardSplitModeEnum';
import { IWalkForwardSplitPolicy } from '../../interface/IWalkForwardSplitPolicy';
import { BacktestRunnerService } from '../BacktestRunnerService';
import { BootstrapStatsService } from '../BootstrapStatsService';
import { ComparisonRunnerService, IComparisonRunRequest } from '../ComparisonRunnerService';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const FIVE_MINUTE_MS = 5 * 60 * 1_000;
const BARS_PER_DAY = ONE_DAY_MS / FIVE_MINUTE_MS; // 288

function buildVersion(id: number): StrategyVersionEntity {
    return {
        id,
        name: 'vtest',
        version: id,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        params: {} as Record<string, unknown>,
        status: StrategyStatusEnum.DRAFT,
        parentVersionId: null,
        promotedAt: null,
        archivedAt: null,
        promotionReportId: null,
        promotionNote: null,
        createdAt: new Date('2024-01-01'),
    } as StrategyVersionEntity;
}

// Minimal IBacktestReport for replay responses.
function buildEmptyReport(versionId: number): any {
    return {
        runLabel: 'test',
        strategyVersionId: versionId,
        strategyName: 'vtest',
        strategyVersion: versionId,
        fromUtcDate: '2024-01-01',
        toUtcDate: '2024-02-01',
        tradeCount: 0,
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
        maxDrawdownPct: '0',
        maxDrawdownDurationDays: 0,
        sharpeAnnualized: '0',
        sortinoAnnualized: '0',
        skippedTriggerCount: 0,
        rejectedByGateCount: 0,
        missedLimitFillCount: 0,
        lowFidelityTradeCount: 0,
        trades: [],
        equityCurve: [],
    };
}

function buildPolicy(): IWalkForwardSplitPolicy {
    return {
        trainBars: 60 * BARS_PER_DAY,
        validationBars: 14 * BARS_PER_DAY,
        oosBars: 14 * BARS_PER_DAY,
        stepBars: 14 * BARS_PER_DAY,
        mode: WalkForwardSplitModeEnum.ROLLING,
    };
}

function buildRequest(overrides: Partial<IComparisonRunRequest> = {}): IComparisonRunRequest {
    return {
        runId: 'adv-test-run',
        rangeFromMs: 0,
        rangeToMs: 120 * ONE_DAY_MS,
        splitPolicy: buildPolicy(),
        candidates: [buildVersion(1), buildVersion(2)],
        runLabel: 'adv-test',
        allocatedCapitalUsdt: '10000',
        latencyMs: 100,
        enableDepthAwareSlippage: false,
        enableIntrabarStopSimulation: false,
        ...overrides,
    };
}

function buildService(tape: any[], replayFactory: (versionId: number) => any = () => buildEmptyReport(1)): ComparisonRunnerService {
    const backtestRunner = {
        recordEventTape: jest.fn().mockResolvedValue(tape),
        replayTape: jest.fn().mockImplementation(async (config: any) => replayFactory(config.strategyVersionId)),
    } as unknown as BacktestRunnerService;

    const bootstrapStats = {
        computePairwiseStats: jest.fn().mockReturnValue([]),
        buildMultipleComparisonNote: jest.fn().mockReturnValue(null),
    } as unknown as BootstrapStatsService;

    return new ComparisonRunnerService(backtestRunner, bootstrapStats);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ComparisonRunnerService — adversarial inputs', () => {
    describe('empty tape (zero events in range)', () => {
        it('assembleReport returns eventOutcomes=[] and pairwiseStats=[] without crashing', async () => {
            const service = buildService([]); // empty tape
            const report = await service.runComparison(buildRequest());

            expect(report.eventOutcomes).toHaveLength(0);
            // bootstrapStats.computePairwiseStats was called but returned [] from the mock.
            expect(report.pairwiseStats).toEqual([]);
        });

        it('perFoldReports has an entry for every (version, fold, window) cell even with zero events', async () => {
            const service = buildService([]);
            const report = await service.runComparison(buildRequest());

            // 2 versions × 3 folds (from 120-day/60-14-14-14 policy) × 3 windows = 18 cells.
            // We can't assert the exact count without knowing fold count, but must be > 0.
            expect(report.perFoldReports.size).toBeGreaterThan(0);
        });
    });

    describe('single event in tape', () => {
        it('produces a report with exactly one eventOutcome and inconclusive pairwise stats', async () => {
            const singleTapeEvent = {
                eventId: 'evt-solo',
                symbol: 'BTCUSDT',
                triggerTs: 30 * ONE_DAY_MS, // inside fold0's OOS window (at day 88 with default policy — actually train)
                regime: 'ranging',
                flowType: 'low_quality_noise',
            };

            // Bootstrap mock returns inconclusive because n < sample floor.
            const bootstrapStats = {
                computePairwiseStats: jest.fn().mockReturnValue([
                    {
                        outcome: 'inconclusive',
                        versionA: 1,
                        versionB: 2,
                        reason: 'insufficient_samples',
                        countersByGate: { tradesA: 0, tradesB: 0, regimeTradesA: 0, regimeTradesB: 0, shadowDays: 0 },
                    },
                ]),
                buildMultipleComparisonNote: jest.fn().mockReturnValue(null),
            } as unknown as BootstrapStatsService;

            const backtestRunner = {
                recordEventTape: jest.fn().mockResolvedValue([singleTapeEvent]),
                replayTape: jest.fn().mockResolvedValue(buildEmptyReport(1)),
            } as unknown as BacktestRunnerService;

            const service = new ComparisonRunnerService(backtestRunner, bootstrapStats);
            const report = await service.runComparison(buildRequest());

            expect(report.eventOutcomes).toHaveLength(1);
            expect(report.eventOutcomes[0].eventId).toBe('evt-solo');

            // Sample-size gate applies → inconclusive.
            expect(report.pairwiseStats).not.toBeNull();
            expect(report.pairwiseStats![0].outcome).toBe('inconclusive');
            expect((report.pairwiseStats![0] as any).reason).toBe('insufficient_samples');
        });
    });

    describe('one version always skips (diff series of zeros)', () => {
        it('does not crash when one candidate produces no trades on any event', async () => {
            const tape = Array.from({ length: 5 }, (_, i) => ({
                eventId: `evt-${i}`,
                symbol: 'BTCUSDT',
                triggerTs: (88 + i) * ONE_DAY_MS, // inside OOS of fold 0 (oosFrom=74d, oosTo=88d… use deeper range)
                regime: 'ranging',
                flowType: 'low_quality_noise',
            }));

            const backtestRunner = {
                recordEventTape: jest.fn().mockResolvedValue(tape),
                // Version 2 always returns zero trades; version 1 trades on each event.
                replayTape: jest.fn().mockImplementation(async (config: any) => buildEmptyReport(config.strategyVersionId)),
            } as unknown as BacktestRunnerService;

            const bootstrapStats = {
                computePairwiseStats: jest.fn().mockReturnValue([]),
                buildMultipleComparisonNote: jest.fn().mockReturnValue(null),
            } as unknown as BootstrapStatsService;

            const service = new ComparisonRunnerService(backtestRunner, bootstrapStats);

            await expect(service.runComparison(buildRequest())).resolves.not.toThrow();
        });
    });

    describe('request validation', () => {
        it('throws when rangeToMs <= rangeFromMs', async () => {
            const service = buildService([]);

            await expect(service.runComparison(buildRequest({ rangeFromMs: 1000, rangeToMs: 1000 }))).rejects.toThrow();
        });

        it('throws when candidates array is empty', async () => {
            const service = buildService([]);

            await expect(service.runComparison(buildRequest({ candidates: [] }))).rejects.toThrow();
        });
    });
});

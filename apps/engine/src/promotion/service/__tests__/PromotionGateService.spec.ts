/**
 * Unit tests for PromotionGateService (M8 W6 / ADR 0019).
 *
 * Strategy: every criterion is exercised through a synthetic IComparisonReport
 * loaded from a fake artefact file. The repositories are mocked. We never touch
 * Postgres in this spec — the integration test for PromotionService covers the
 * serializable-transaction shape against the real DB.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { BACKTEST_ARTEFACT_ROOT } from '../../../backtest/const/backtestConsts';

import { FlowTypeEnum, IBacktestReport, IBacktestTradeResult, RegimeLabelEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { WalkForwardSplitModeEnum } from '../../../backtest/enum/WalkForwardSplitModeEnum';

import { ComparisonReportEntity } from '../../../strategy/entity/ComparisonReportEntity';
import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { IComparisonReport } from '../../../backtest/interface';
import { IPairwiseBootstrapResult } from '../../../backtest/interface/IPairwiseBootstrapResult';
import { MIN_PROFIT_FACTOR } from '../../const/promotionGateConsts';
import { PromotionGateService } from '../PromotionGateService';

const CANDIDATE_ID = 101;
const BASELINE_ID = 100;
const REPORT_ID = 7;

describe('PromotionGateService — unit (synthetic IComparisonReport)', () => {
    let tempArtefactPath: string;

    beforeEach(async () => {
        await fs.mkdir(BACKTEST_ARTEFACT_ROOT, { recursive: true });
        tempArtefactPath = path.join(BACKTEST_ARTEFACT_ROOT, `gate-fixture-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    });

    afterEach(async () => {
        try {
            await fs.unlink(tempArtefactPath);
        } catch {
            // best effort — tempfile may not exist if a test failed early
        }
    });

    function buildService(report: IComparisonReport, candidate: StrategyVersionEntity, baseline: StrategyVersionEntity | null): PromotionGateService {
        const strategyVersionRepository = {
            findById: jest.fn(async (id: number) => (id === candidate.id ? candidate : baseline?.id === id ? baseline : null)),
            findActive: jest.fn(async () => (baseline === null ? [] : [baseline])),
        } as never;

        const reportRow: ComparisonReportEntity = {
            id: REPORT_ID,
            runLabel: 'unit',
            fromMs: '0',
            toMs: '0',
            splitPolicy: {},
            folds: [],
            versionIds: [candidate.id, baseline?.id ?? 0],
            summary: {},
            artefactUri: tempArtefactPath,
            createdAt: new Date(),
        };

        const comparisonReportRepository = {
            findById: jest.fn(async () => reportRow),
        } as never;

        // Write the artefact file in the JSON-serializable form (Maps → arrays).
        return new PromotionGateService(strategyVersionRepository, comparisonReportRepository);
    }

    async function writeArtefact(report: IComparisonReport): Promise<void> {
        const serialisable = {
            ...report,
            perFoldReports: Array.from(report.perFoldReports.entries()),
            regimeBreakdown:
                report.regimeBreakdown === null
                    ? null
                    : Array.from(report.regimeBreakdown.entries()).map(([versionId, metrics]) => [
                          versionId,
                          { buckets: Array.from(metrics.buckets.entries()) },
                      ]),
            eventOutcomes: report.eventOutcomes.map((entry) => ({ ...entry, outcomesByVersion: Array.from(entry.outcomesByVersion.entries()) })),
        };
        await fs.writeFile(tempArtefactPath, JSON.stringify(serialisable));
    }

    it('all criteria pass on a clean report → decision=promote', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        // Criteria 7 & 9 are deferred → severity 'deferred' → decision must NOT
        // be 'promote' in W6; it downgrades to 'inconclusive' with
        // reason='robustness_pending'. This is the explicit W6 safety guard.
        // Debug-friendly assertion: show which block-severity failure was raised.
        const blockFailures = outcome.failedCriteria.filter((f) => f.severity === 'block').map((f) => ({ i: f.index, n: f.name, o: f.observed }));
        expect(blockFailures).toEqual([]);
        expect(outcome.decision).toBe('inconclusive');
        expect(outcome.inconclusiveReason).toBe('robustness_pending');
        // The other ten criteria all pass.
        expect(outcome.passedCriteria).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 11, 12]);
    });

    it('criterion 1 fails when an OOS fold has non-positive net PnL → reject', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        report.perFoldReports.set(oosKey, { ...cell, netPnlUsdt: '-1.00' });
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('reject');
        expect(outcome.failedCriteria.some((failure) => failure.index === 1 && failure.severity === 'block')).toBe(true);
    });

    it('criterion 4 fails when the worst day exceeds the survivability threshold → reject', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        const equityCurve = [...cell.equityCurve, { utcDate: '2026-04-30', equityUsdt: '900', dailyReturnPct: '-12.5' }];
        report.perFoldReports.set(oosKey, { ...cell, equityCurve });
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('reject');
        expect(outcome.failedCriteria.find((failure) => failure.index === 4)?.severity).toBe('block');
    });

    it('criterion 5 inconclusive when pairwise bootstrap is inconclusive', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        const stats: IPairwiseBootstrapResult[] = [
            {
                outcome: 'inconclusive',
                versionA: candidate.id,
                versionB: baseline.id,
                reason: 'insufficient_samples',
                countersByGate: { tradesA: 250, tradesB: 250, regimeTradesA: 150, regimeTradesB: 150, shadowDays: 60 },
            },
        ];
        const reportWithStats: IComparisonReport = { ...report, pairwiseStats: stats };
        await writeArtefact(reportWithStats);

        const service = buildService(reportWithStats, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('inconclusive');
        // Both criterion 5 (statistical) and criteria 7+9 (robustness deferred)
        // fail with non-block severity. robustness_pending takes priority in the
        // reason classifier.
        expect(outcome.failedCriteria.some((failure) => failure.index === 5)).toBe(true);
        expect(outcome.inconclusiveReason).toBe('robustness_pending');
    });

    it('criterion 6 inconclusive when sample sufficiency gates fail', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        // Halve the sample counters below MIN_TOTAL_TRADES.
        const stats = report.pairwiseStats!.map((pair) => ({
            ...pair,
            countersByGate: { tradesA: 50, tradesB: 50, regimeTradesA: 20, regimeTradesB: 20, shadowDays: 10 },
        })) as IPairwiseBootstrapResult[];
        const reportWithStats: IComparisonReport = { ...report, pairwiseStats: stats };
        await writeArtefact(reportWithStats);

        const service = buildService(reportWithStats, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('inconclusive');
        expect(outcome.failedCriteria.find((failure) => failure.index === 6)?.severity).toBe('inconclusive');
    });

    it('criterion 10 fails when a single symbol carries more than the concentration limit', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        // Pump BTCUSDT to 60% of OOS trades (well above MAX_SYMBOL_CONCENTRATION_PCT).
        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        const heavySymbol: IBacktestTradeResult[] = Array.from({ length: 6 }, (_, i) =>
            buildTrade(`evt-btc-${i}`, 'BTCUSDT', '1.00', 1700000000000 + i * 86_400_000),
        );
        const lightSymbol: IBacktestTradeResult[] = Array.from({ length: 4 }, (_, i) =>
            buildTrade(`evt-other-${i}`, `OTHER${i}USDT`, '1.00', 1700000000000 + (10 + i) * 86_400_000),
        );
        report.perFoldReports.set(oosKey, { ...cell, trades: [...heavySymbol, ...lightSymbol] });
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.failedCriteria.find((failure) => failure.index === 10)?.severity).toBe('block');
        expect(outcome.decision).toBe('reject');
    });

    it('criterion 8 fails when expectancy collapses after dropping top 5% of trades', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        // 19 break-even trades + 1 massive winner. Drop-best-5% removes the
        // winner; remaining expectancy ≤ 0.
        const trades: IBacktestTradeResult[] = Array.from({ length: 19 }, (_, i) => buildTrade(`evt-${i}`, 'BTCUSDT', '0.00', 1700000000000 + i * 86_400_000));
        trades.push(buildTrade('evt-jackpot', 'ETHUSDT', '500.00', 1700000000000 + 20 * 86_400_000));
        report.perFoldReports.set(oosKey, { ...cell, trades });
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.failedCriteria.find((failure) => failure.index === 8)?.severity).toBe('block');
    });

    it('criterion 11 fails when the candidate does not beat the baseline on its target regime', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        // Flip the regime breakdown so the baseline outperforms the candidate
        // on RANGING (the mean-reversion target).
        const flippedReport: IComparisonReport = {
            ...report,
            regimeBreakdown: new Map([
                [
                    candidate.id,
                    {
                        buckets: new Map([
                            [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.1, winRate: 0.55, totalR: 10 }],
                            [RegimeLabelEnum.TRANSITIONING, { tradeCount: 50, meanR: 0.5, winRate: 0.6, totalR: 25 }],
                        ]),
                    },
                ],
                [
                    baseline.id,
                    {
                        buckets: new Map([
                            [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.4, winRate: 0.6, totalR: 40 }],
                            [RegimeLabelEnum.TRANSITIONING, { tradeCount: 50, meanR: 0.3, winRate: 0.55, totalR: 15 }],
                        ]),
                    },
                ],
            ]),
        };
        await writeArtefact(flippedReport);

        const service = buildService(flippedReport, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.failedCriteria.find((failure) => failure.index === 11)?.severity).toBe('block');
    });

    it('always reports criteria 7 and 9 as deferred in W6', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, 'v1', StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        const slippage = outcome.failedCriteria.find((failure) => failure.name === 'slippage_stress_doubled');
        const stress = outcome.failedCriteria.find((failure) => failure.name === 'stress_windows');
        expect(slippage?.severity).toBe('deferred');
        expect(stress?.severity).toBe('deferred');
    });

    it('rejects when the candidate has no current baseline (criteria 5 and 11 both fail)', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, 'v1', StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, 0);
        await writeArtefact(report);

        const service = buildService(report, candidate, null);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        // Criterion 5 is 'inconclusive' (no baseline) AND criterion 11 is 'block'.
        // Block wins → decision = reject.
        expect(outcome.decision).toBe('reject');
        expect(outcome.failedCriteria.find((failure) => failure.index === 11)?.severity).toBe('block');
    });
});

// --- Fixture builders --------------------------------------------------------

function buildStrategy(id: number, name: string, status: StrategyStatusEnum, direction: StrategyDirectionEnum): StrategyVersionEntity {
    return {
        id,
        name,
        version: id,
        direction,
        params: {},
        status,
        parentVersionId: null,
        createdAt: new Date(),
    } as StrategyVersionEntity;
}

function buildTrade(eventId: string, symbol: string, netPnlUsdt: string, openedAtMs: number): IBacktestTradeResult {
    return {
        eventId,
        symbol,
        strategyVersionId: CANDIDATE_ID,
        side: 'long',
        slot: 'A',
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        regimeAtEntry: RegimeLabelEnum.RANGING,
        coinTier: 'tier1',
        entryPriceUsdt: '100',
        exitPriceUsdt: '101',
        qty: '1',
        grossPnlUsdt: '1',
        feesUsdt: '0',
        fundingUsdt: '0',
        slippageCostUsdt: '0',
        netPnlUsdt,
        riskBudgetSpent: '1',
        returnPct: '1',
        openedAtMs,
        closedAtMs: openedAtMs + 3_600_000,
        holdMs: 3_600_000,
        exitReason: 'take_profit',
        lowFidelity: false,
    };
}

function buildBacktestReport(
    versionId: number,
    foldIndex: number,
    window: 'train' | 'validation' | 'oos',
    overrides: Partial<IBacktestReport> = {},
): IBacktestReport {
    // Spread across 5 symbols + 12 ISO weeks so default concentration thresholds
    // (40% per symbol, 30% per week) are not breached by the clean fixture.
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT'];
    const baseTrades: IBacktestTradeResult[] = Array.from({ length: 12 }, (_, i) =>
        buildTrade(
            `evt-${versionId}-${foldIndex}-${window}-${i}`,
            symbols[i % symbols.length],
            i % 3 === 0 ? '-0.50' : '1.50',
            1700000000000 + i * 86_400_000 * 7,
        ),
    );

    return {
        runLabel: `${versionId}:f${foldIndex}:${window}`,
        strategyVersionId: versionId,
        strategyName: 'v1',
        strategyVersion: versionId,
        fromUtcDate: '2026-01-01',
        toUtcDate: '2026-04-01',
        tradeCount: 12,
        winCount: 8,
        lossCount: 4,
        winRatePct: '66.67',
        grossPnlUsdt: '12.00',
        feesUsdt: '0.10',
        fundingUsdt: '0.00',
        slippageCostUsdt: '0.05',
        netPnlUsdt: '11.85',
        returnPct: '1.18',
        profitFactor: (MIN_PROFIT_FACTOR + 0.5).toString(),
        avgHoldMs: 3_600_000,
        maxDrawdownPct: '3.5',
        maxDrawdownDurationDays: 2,
        sharpeAnnualized: '1.5',
        sortinoAnnualized: '2.0',
        skippedTriggerCount: 0,
        rejectedByGateCount: 0,
        missedLimitFillCount: 0,
        lowFidelityTradeCount: 0,
        equityCurve: [
            { utcDate: '2026-01-01', equityUsdt: '1000', dailyReturnPct: '0.0' },
            { utcDate: '2026-02-01', equityUsdt: '1010', dailyReturnPct: '1.0' },
            { utcDate: '2026-03-01', equityUsdt: '1020', dailyReturnPct: '-0.5' },
        ],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades: baseTrades,
        ...overrides,
    };
}

function buildCleanReport(versionId: number, baselineId: number): IComparisonReport {
    const perFoldReports = new Map<`${number}:${number}:${'train' | 'validation' | 'oos'}`, IBacktestReport>();
    perFoldReports.set(`${versionId}:0:train`, buildBacktestReport(versionId, 0, 'train'));
    perFoldReports.set(`${versionId}:0:validation`, buildBacktestReport(versionId, 0, 'validation'));
    perFoldReports.set(`${versionId}:0:oos`, buildBacktestReport(versionId, 0, 'oos'));
    perFoldReports.set(`${baselineId}:0:oos`, buildBacktestReport(baselineId, 0, 'oos'));

    const pairwiseStats: IPairwiseBootstrapResult[] = [
        {
            outcome: 'conclusive',
            versionA: versionId,
            versionB: baselineId,
            winner: 'A',
            meanDiff: 0.15,
            ci95Low: 0.05,
            ci95High: 0.25,
            blockLen: 8,
            n: 200,
            countersByGate: { tradesA: 250, tradesB: 250, regimeTradesA: 120, regimeTradesB: 120, shadowDays: 45 },
        },
    ];

    const regimeBreakdown = new Map([
        [
            versionId,
            {
                buckets: new Map([
                    [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.4, winRate: 0.6, totalR: 40 }],
                    [RegimeLabelEnum.TRANSITIONING, { tradeCount: 50, meanR: 0.5, winRate: 0.6, totalR: 25 }],
                ]),
            },
        ],
        [
            baselineId,
            {
                buckets: new Map([
                    [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.1, winRate: 0.55, totalR: 10 }],
                    [RegimeLabelEnum.TRANSITIONING, { tradeCount: 50, meanR: 0.2, winRate: 0.5, totalR: 10 }],
                ]),
            },
        ],
    ]);

    return {
        runId: 'unit-run',
        rangeFromMs: 1700000000000,
        rangeToMs: 1700864000000,
        splitPolicy: { trainBars: 60, validationBars: 14, oosBars: 14, stepBars: 14, mode: WalkForwardSplitModeEnum.ROLLING },
        folds: [],
        versions: [],
        perFoldReports,
        eventOutcomes: [],
        pairwiseStats,
        regimeBreakdown,
        tailRiskByVersion: null,
        multipleComparisonNote: null,
        promotionDecisions: null,
        lowFidelityTradeCount: 0,
    };
}

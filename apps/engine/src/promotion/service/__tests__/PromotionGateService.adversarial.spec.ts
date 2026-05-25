/**
 * Adversarial tests for PromotionGateService (M8 W8 QA / ADR 0019).
 *
 * Cluster: failure-mode and edge-case scenarios not covered by the happy-path spec.
 * Focus: precedence of decision severities, first-ever-active path, momentum
 * direction regime targeting, and block-beats-inconclusive rule.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { FlowTypeEnum, IBacktestReport, IBacktestTradeResult, RegimeLabelEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { BACKTEST_ARTEFACT_ROOT } from '../../../backtest/const/backtestConsts';
import { WalkForwardSplitModeEnum } from '../../../backtest/enum/WalkForwardSplitModeEnum';
import { IComparisonReport } from '../../../backtest/interface';
import { IPairwiseBootstrapResult } from '../../../backtest/interface/IPairwiseBootstrapResult';
import { ComparisonReportEntity } from '../../../strategy/entity/ComparisonReportEntity';
import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { WORST_DAY_LOSS_TOLERANCE_PCT, MIN_PROFIT_FACTOR, REGIME_TARGETS_BY_DIRECTION } from '../../const/promotionGateConsts';
import { PromotionGateService } from '../PromotionGateService';

const CANDIDATE_ID = 201;
const BASELINE_ID = 200;
const REPORT_ID = 42;

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildStrategy(id: number, status: StrategyStatusEnum, direction: StrategyDirectionEnum, name = 'adv-strategy'): StrategyVersionEntity {
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
        grossPnlUsdt: netPnlUsdt,
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

function buildOosReport(versionId: number, overrides: Partial<IBacktestReport> = {}): IBacktestReport {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT'];
    const trades: IBacktestTradeResult[] = Array.from({ length: 12 }, (_, i) =>
        buildTrade(`evt-adv-${versionId}-${i}`, symbols[i % symbols.length], i % 3 === 0 ? '-0.50' : '1.50', 1_700_000_000_000 + i * 86_400_000 * 7),
    );

    return {
        runLabel: `adv:${versionId}:0:oos`,
        strategyVersionId: versionId,
        strategyName: 'adv-strategy',
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
        ],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades,
        ...overrides,
    };
}

function buildCleanReport(candidateId: number, baselineId: number): IComparisonReport {
    const perFoldReports = new Map<`${number}:${number}:${'train' | 'validation' | 'oos'}`, IBacktestReport>();
    perFoldReports.set(`${candidateId}:0:oos`, buildOosReport(candidateId));
    perFoldReports.set(`${candidateId}:0:train`, buildOosReport(candidateId));
    perFoldReports.set(`${candidateId}:0:validation`, buildOosReport(candidateId));
    perFoldReports.set(`${baselineId}:0:oos`, buildOosReport(baselineId));

    const pairwiseStats: IPairwiseBootstrapResult[] = [
        {
            outcome: 'conclusive',
            versionA: candidateId,
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
            candidateId,
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
        runId: 'adv-run',
        rangeFromMs: 1_700_000_000_000,
        rangeToMs: 1_700_864_000_000,
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

// ─── test harness ─────────────────────────────────────────────────────────────

describe('PromotionGateService — adversarial failure modes', () => {
    let tempArtefactPath: string;

    beforeEach(async () => {
        await fs.mkdir(BACKTEST_ARTEFACT_ROOT, { recursive: true });
        tempArtefactPath = path.join(BACKTEST_ARTEFACT_ROOT, `gate-adv-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    });

    afterEach(async () => {
        try {
            await fs.unlink(tempArtefactPath);
        } catch {
            // best-effort
        }
    });

    function buildService(report: IComparisonReport, candidate: StrategyVersionEntity, baseline: StrategyVersionEntity | null): PromotionGateService {
        const strategyVersionRepository = {
            findById: jest.fn(async (id: number) => (id === candidate.id ? candidate : baseline?.id === id ? baseline : null)),
            findActive: jest.fn(async () => (baseline === null ? [] : [baseline])),
        } as never;

        const reportRow: ComparisonReportEntity = {
            id: REPORT_ID,
            runLabel: 'adv',
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

    it('criteria 7+9 deferred with all others passing → decision=inconclusive, inconclusiveReason=robustness_pending', async () => {
        // This is the current W6 state: 7+9 always deferred. Verifying the
        // downgrade from 'promote' to 'inconclusive' is the explicit safety guard.
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('inconclusive');
        expect(outcome.inconclusiveReason).toBe('robustness_pending');
        expect(outcome.failedCriteria.filter((f) => f.severity === 'block')).toHaveLength(0);
    });

    it('criterion 4 failing (worst day exceeds tolerance) → decision=reject, severity=block', async () => {
        const worstDayPct = -(WORST_DAY_LOSS_TOLERANCE_PCT + 1); // one point above the limit
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);

        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        const equityCurveWithWorstDay = [...cell.equityCurve, { utcDate: '2026-03-15', equityUsdt: '900', dailyReturnPct: String(worstDayPct) }];
        report.perFoldReports.set(oosKey, { ...cell, equityCurve: equityCurveWithWorstDay });
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('reject');
        const crit4 = outcome.failedCriteria.find((f) => f.index === 4);
        expect(crit4).toBeDefined();
        expect(crit4!.severity).toBe('block');
    });

    it('criterion 1 (block) AND criterion 5 (inconclusive) failing → decision=reject, not inconclusive', async () => {
        // Block severity beats inconclusive — reject must win.
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, baseline.id);

        // Make criterion 1 fail (negative OOS PnL).
        const oosKey = `${candidate.id}:0:oos` as const;
        const cell = report.perFoldReports.get(oosKey)!;
        report.perFoldReports.set(oosKey, { ...cell, netPnlUsdt: '-5.00' });

        // Make criterion 5 inconclusive (bootstrap inconclusive).
        const inconclusivePairwise: IPairwiseBootstrapResult[] = [
            {
                outcome: 'inconclusive',
                versionA: candidate.id,
                versionB: baseline.id,
                reason: 'insufficient_samples',
                countersByGate: { tradesA: 100, tradesB: 100, regimeTradesA: 50, regimeTradesB: 50, shadowDays: 10 },
            },
        ];
        const reportWithBothFailures: IComparisonReport = { ...report, pairwiseStats: inconclusivePairwise };
        await writeArtefact(reportWithBothFailures);

        const service = buildService(reportWithBothFailures, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('reject');
        expect(outcome.failedCriteria.some((f) => f.index === 1 && f.severity === 'block')).toBe(true);
        expect(outcome.failedCriteria.some((f) => f.index === 5)).toBe(true);
    });

    it('no active baseline exists → criterion 11 block fires, decision=reject (not first-ever pass)', async () => {
        // When no active row exists for the name, the gate documents this as a
        // block on criterion 11 (cannot demonstrate regime superiority without a peer).
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const report = buildCleanReport(candidate.id, 0); // 0 = no real baseline
        await writeArtefact(report);

        const service = buildService(report, candidate, null);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        expect(outcome.decision).toBe('reject');
        const crit11 = outcome.failedCriteria.find((f) => f.index === 11);
        expect(crit11?.severity).toBe('block');
        expect(crit11?.observed).toContain('no active baseline');
    });

    it('MOMENTUM candidate wins on RANGING but loses on TRENDING_UP → criterion 11 fails', async () => {
        // REGIME_TARGETS_BY_DIRECTION.MOMENTUM = [TRENDING_UP, TRENDING_DOWN].
        // Candidate outperforms baseline on RANGING (irrelevant) but loses on
        // TRENDING_UP (the target) → criterion 11 must fail.
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MOMENTUM);
        const baseline = buildStrategy(BASELINE_ID, StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MOMENTUM);

        // Confirm the constant so the test self-documents the target.
        expect(REGIME_TARGETS_BY_DIRECTION[StrategyDirectionEnum.MOMENTUM]).toContain(RegimeLabelEnum.TRENDING_UP);

        const report = buildCleanReport(candidate.id, baseline.id);

        // Override regime breakdown: candidate wins RANGING, loses TRENDING_UP.
        const momentumRegimeBreakdown = new Map([
            [
                candidate.id,
                {
                    buckets: new Map([
                        [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.9, winRate: 0.7, totalR: 90 }],
                        [RegimeLabelEnum.TRENDING_UP, { tradeCount: 80, meanR: 0.1, winRate: 0.5, totalR: 8 }],
                        [RegimeLabelEnum.TRENDING_DOWN, { tradeCount: 80, meanR: 0.3, winRate: 0.55, totalR: 24 }],
                    ]),
                },
            ],
            [
                baseline.id,
                {
                    buckets: new Map([
                        [RegimeLabelEnum.RANGING, { tradeCount: 100, meanR: 0.2, winRate: 0.5, totalR: 20 }],
                        [RegimeLabelEnum.TRENDING_UP, { tradeCount: 80, meanR: 0.5, winRate: 0.65, totalR: 40 }], // baseline wins here
                        [RegimeLabelEnum.TRENDING_DOWN, { tradeCount: 80, meanR: 0.2, winRate: 0.5, totalR: 16 }],
                    ]),
                },
            ],
        ]);

        const momentumReport: IComparisonReport = { ...report, regimeBreakdown: momentumRegimeBreakdown };
        await writeArtefact(momentumReport);

        const service = buildService(momentumReport, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        const crit11 = outcome.failedCriteria.find((f) => f.index === 11);
        expect(crit11).toBeDefined();
        expect(crit11!.severity).toBe('block');
        // The threshold field names the failing regime; observed carries the numeric comparison.
        expect(crit11!.threshold).toContain(`regime=${RegimeLabelEnum.TRENDING_UP}`);
        expect(crit11!.observed).toContain('candidate=');
    });

    // R1-H1 paired regression: a 200-trade OOS tape with 4 regimes (50 per regime),
    // bootstrap supplies the 200 OPEN counts but zeros for regimeTradesA/B and shadowDays
    // (the production path). The pickSampleCounters fallback must filter trades by
    // regimeAtEntry against REGIME_TARGETS_BY_DIRECTION[MEAN_REVERSION] =
    // [RANGING, TRANSITIONING], yielding 100 trades — exactly MIN_REGIME_TRADES — and
    // criterion 6 must NOT trip on regime-trade sufficiency. Pre-fix this test fails
    // because regimeTradesA=0 from bootstrap.
    it('R1-H1: bootstrap zeros for regime/shadow counters fall through to tape-derived counts filtered by target regimes', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);
        const baseline = buildStrategy(BASELINE_ID, StrategyStatusEnum.ACTIVE, StrategyDirectionEnum.MEAN_REVERSION);

        // 200 trades spread across 4 regimes (50 each), 50 distinct days each (200 distinct
        // total) so the shadow-days gate also clears via tape fallback.
        const regimes: RegimeLabelEnum[] = [RegimeLabelEnum.RANGING, RegimeLabelEnum.TRANSITIONING, RegimeLabelEnum.TRENDING_UP, RegimeLabelEnum.TRENDING_DOWN];
        const trades: IBacktestTradeResult[] = [];
        for (let i = 0; i < 200; i += 1) {
            const regime = regimes[i % 4];
            // Use 5 symbols spread evenly so per-symbol concentration <= 40%.
            const symbol = `SYM${i % 5}USDT`;
            trades.push({
                ...buildTrade(`evt-h1-${i}`, symbol, '0.10', 1_700_000_000_000 + i * 86_400_000),
                regimeAtEntry: regime,
            });
        }

        const oosReport = buildOosReport(candidate.id, { trades, tradeCount: trades.length });
        const baselineOos = buildOosReport(baseline.id);
        const perFoldReports = new Map<`${number}:${number}:${'train' | 'validation' | 'oos'}`, IBacktestReport>();
        perFoldReports.set(`${candidate.id}:0:oos`, oosReport);
        perFoldReports.set(`${candidate.id}:0:train`, buildOosReport(candidate.id));
        perFoldReports.set(`${candidate.id}:0:validation`, buildOosReport(candidate.id));
        perFoldReports.set(`${baseline.id}:0:oos`, baselineOos);

        // Bootstrap path: 200 OPEN trades each side, but ZEROS for regime/shadow — the
        // exact shape BootstrapStatsService.computeOnePair returns in production.
        const pairwiseStats: IPairwiseBootstrapResult[] = [
            {
                outcome: 'conclusive',
                versionA: candidate.id,
                versionB: baseline.id,
                winner: 'A',
                meanDiff: 0.15,
                ci95Low: 0.05,
                ci95High: 0.25,
                blockLen: 8,
                n: 200,
                countersByGate: { tradesA: 200, tradesB: 200, regimeTradesA: 0, regimeTradesB: 0, shadowDays: 0 },
            },
        ];

        const cleanReport = buildCleanReport(candidate.id, baseline.id);
        const report: IComparisonReport = { ...cleanReport, perFoldReports, pairwiseStats };
        await writeArtefact(report);

        const service = buildService(report, candidate, baseline);
        const outcome = await service.evaluate(candidate.id, REPORT_ID);

        // Criterion 6 must not appear in failedCriteria — tape fallback supplied
        // 100 trades in [RANGING, TRANSITIONING] (the MEAN_REVERSION targets) and
        // 200 distinct shadow days. Both clear MIN_REGIME_TRADES (100) and
        // MIN_SHADOW_DAYS (30).
        expect(outcome.passedCriteria).toContain(6);
        expect(outcome.failedCriteria.find((f) => f.index === 6)).toBeUndefined();
    });

    it('missing comparison report row → throws with a clear message', async () => {
        const candidate = buildStrategy(CANDIDATE_ID, StrategyStatusEnum.DRAFT, StrategyDirectionEnum.MEAN_REVERSION);

        const strategyVersionRepository = {
            findById: jest.fn(async (id: number) => (id === candidate.id ? candidate : null)),
            findActive: jest.fn(async () => []),
        } as never;

        const comparisonReportRepository = {
            findById: jest.fn(async () => null), // report not found
        } as never;

        const service = new PromotionGateService(strategyVersionRepository, comparisonReportRepository);

        await expect(service.evaluate(candidate.id, REPORT_ID)).rejects.toThrow(/comparison report/i);
    });
});

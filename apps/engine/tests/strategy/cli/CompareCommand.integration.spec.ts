/**
 * CompareCommand — integration test (M8 W7).
 *
 * Drives an end-to-end `strategy compare` invocation with a mocked
 * ComparisonRunnerService (so we do not depend on real historical candles)
 * and asserts:
 *   (1) the full IComparisonReport JSON artefact is written to disk under
 *       BACKTEST_ARTEFACT_DIR.
 *   (2) a row is persisted in comparison_reports with artefact_uri pointing
 *       at the written file, the correct version_ids array, and a non-empty
 *       summary jsonb blob.
 *   (3) the report id and a non-empty ASCII summary table are returned for
 *       stdout rendering.
 *
 * Requires live Postgres (per testDataSource.ts). The fixture spans 1 fold
 * (rolling, train+validation+oos = 88 days mapped to 5-min bars) over 2 versions
 * so the contract is honored without driving the actual replay loop.
 */

import { FlowTypeEnum, RegimeLabelEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';
import { promises as fs } from 'fs';
import { DataSource, Repository } from 'typeorm';

import { BACKTEST_ARTEFACT_ROOT } from '../../../src/backtest/const/backtestConsts';
import { ComparisonRunnerService } from '../../../src/backtest/service/ComparisonRunnerService';
import { WalkForwardSplitModeEnum } from '../../../src/backtest/enum/WalkForwardSplitModeEnum';
import { IComparisonReport } from '../../../src/backtest/interface';
import { CompareCommand } from '../../../src/strategy/cli/CompareCommand';
import { ComparisonReportEntity, StrategyVersionEntity } from '../../../src/strategy/entity';
import { ComparisonReportRepository } from '../../../src/strategy/repository/ComparisonReportRepository';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { getTestDataSource } from '../../support/testDataSource';

const NAME_PREFIX = 'test_compare_cli_';

describe('CompareCommand (integration — requires Postgres)', () => {
    let dataSource: DataSource;
    let strategyRepository: Repository<StrategyVersionEntity>;
    let comparisonRepository: Repository<ComparisonReportEntity>;
    let artefactDir: string;
    const versionRows: StrategyVersionEntity[] = [];
    const writtenArtefactPaths: string[] = [];

    beforeAll(async () => {
        dataSource = await getTestDataSource();
        strategyRepository = dataSource.getRepository(StrategyVersionEntity);
        comparisonRepository = dataSource.getRepository(ComparisonReportEntity);

        // CompareCommand writes artefacts under BACKTEST_ARTEFACT_ROOT, which is
        // frozen at module-load from env — setting process.env here would be a
        // no-op. Use the resolved root directly (the production write target).
        artefactDir = BACKTEST_ARTEFACT_ROOT;
        await fs.mkdir(artefactDir, { recursive: true });

        for (const version of [1, 2]) {
            const row = await strategyRepository.save(
                strategyRepository.create({
                    name: `${NAME_PREFIX}v_${Date.now()}`,
                    version,
                    direction: StrategyDirectionEnum.MEAN_REVERSION,
                    params: {},
                    status: StrategyStatusEnum.DRAFT,
                }),
            );
            versionRows.push(row);
        }
    }, 60_000);

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.query(`DELETE FROM "comparison_reports" WHERE "run_label" LIKE $1`, [`${NAME_PREFIX}%`]);
            await dataSource.query(`DELETE FROM "strategy_versions" WHERE "name" LIKE $1`, [`${NAME_PREFIX}%`]);
        }
        // artefactDir is the shared BACKTEST_ARTEFACT_ROOT — never remove the
        // directory itself; only the specific artefact files this test wrote.
        for (const file of writtenArtefactPaths) {
            await fs.unlink(file).catch(() => undefined);
        }
    }, 30_000);

    it('writes the artefact, persists comparison_reports row, returns a summary table', async () => {
        const versionA = versionRows[0];
        const versionB = versionRows[1];
        const fromMs = Date.parse('2025-01-01T00:00:00Z');
        const toMs = Date.parse('2025-04-01T00:00:00Z');

        const fakeReport: IComparisonReport = {
            runId: 'fake-run-id',
            rangeFromMs: fromMs,
            rangeToMs: toMs,
            splitPolicy: { trainBars: 60 * 288, validationBars: 14 * 288, oosBars: 14 * 288, stepBars: 14 * 288, mode: WalkForwardSplitModeEnum.ROLLING },
            folds: [
                {
                    foldIndex: 0,
                    trainFromMs: fromMs,
                    trainToMs: fromMs + 60 * 288 * 5 * 60 * 1000,
                    validationFromMs: fromMs + 60 * 288 * 5 * 60 * 1000,
                    validationToMs: fromMs + 74 * 288 * 5 * 60 * 1000,
                    oosFromMs: fromMs + 74 * 288 * 5 * 60 * 1000,
                    oosToMs: fromMs + 88 * 288 * 5 * 60 * 1000,
                },
            ],
            versions: [
                { versionId: versionA.id, name: versionA.name, version: versionA.version, direction: versionA.direction, paramsHash: 'aaa' },
                { versionId: versionB.id, name: versionB.name, version: versionB.version, direction: versionB.direction, paramsHash: 'bbb' },
            ],
            perFoldReports: new Map<`${number}:${number}:oos`, ReturnType<typeof buildLeafReport>>([
                [
                    `${versionA.id}:0:oos`,
                    buildLeafReport({
                        runLabel: 'run-A:oos',
                        strategyVersionId: versionA.id,
                        tradeCount: 3,
                        netPnlUsdt: '15.00',
                        profitFactor: '1.50',
                        sharpeAnnualized: '1.20',
                    }),
                ],
                [
                    `${versionB.id}:0:oos`,
                    buildLeafReport({
                        runLabel: 'run-B:oos',
                        strategyVersionId: versionB.id,
                        tradeCount: 5,
                        netPnlUsdt: '-3.00',
                        profitFactor: '0.80',
                        sharpeAnnualized: '-0.10',
                    }),
                ],
            ]),
            eventOutcomes: [
                {
                    eventId: 'evt-1',
                    symbol: 'BTCUSDT',
                    triggerTs: fromMs + 1000,
                    regime: RegimeLabelEnum.TRENDING_UP,
                    flowType: FlowTypeEnum.TREND_INITIATION,
                    outcomesByVersion: new Map([
                        [versionA.id, { action: 'open', rPerUnitRisk: 1.5 }],
                        [versionB.id, { action: 'skip', rPerUnitRisk: 0 }],
                    ]),
                },
            ],
            pairwiseStats: [
                {
                    outcome: 'conclusive',
                    versionA: versionA.id,
                    versionB: versionB.id,
                    winner: 'A',
                    meanDiff: 0.5,
                    ci95Low: 0.1,
                    ci95High: 0.9,
                    blockLen: 5,
                    n: 50,
                    countersByGate: { tradesA: 50, tradesB: 60, regimeTradesA: 25, regimeTradesB: 30, shadowDays: 45 },
                },
            ],
            regimeBreakdown: null,
            tailRiskByVersion: null,
            multipleComparisonNote: null,
            promotionDecisions: null,
            lowFidelityTradeCount: 0,
        };

        const runner = { runComparison: jest.fn(async () => fakeReport) } as unknown as ComparisonRunnerService;
        const comparisonReportRepo = new ComparisonReportRepository(comparisonRepository);
        const strategyVersionRepo = new StrategyVersionRepository(strategyRepository);

        const command = new CompareCommand(runner, comparisonReportRepo, strategyVersionRepo);

        const runLabel = `${NAME_PREFIX}endtoend_${Date.now()}`;
        const result = await command.execute({
            fromMs,
            toMs,
            versionSpecs: [
                { kind: 'id', id: versionA.id },
                { kind: 'id', id: versionB.id },
            ],
            splitPolicy: fakeReport.splitPolicy,
            runLabel,
        });

        writtenArtefactPaths.push(result.artefactPath);

        // (1) Artefact written
        expect(result.artefactPath).toMatch(new RegExp(`^${escapeRegExp(artefactDir)}/comparison-${escapeRegExp(runLabel)}-.*\\.json$`));
        const artefactRaw = await fs.readFile(result.artefactPath, 'utf8');
        const artefactParsed = JSON.parse(artefactRaw) as Record<string, unknown>;
        expect(artefactParsed['runId']).toBe('fake-run-id');
        expect(Array.isArray(artefactParsed['perFoldReports'])).toBe(true);
        expect((artefactParsed['perFoldReports'] as unknown[]).length).toBe(2);

        // (2) DB row persisted
        const persisted = await comparisonRepository.findOne({ where: { id: result.reportId } });
        expect(persisted).not.toBeNull();
        expect(persisted!.runLabel).toBe(runLabel);
        expect(persisted!.versionIds).toEqual([versionA.id, versionB.id]);
        expect(persisted!.artefactUri).toBe(result.artefactPath);
        expect(persisted!.summary).toMatchObject({ foldCount: 1, lowFidelityTradeCount: 0 });

        // (3) Summary table contains both versions and the pair line
        expect(result.summaryTable).toContain(`${versionA.name}:${versionA.version}`);
        expect(result.summaryTable).toContain(`${versionB.name}:${versionB.version}`);
        expect(result.summaryTable).toContain('Pairwise winners:');
        expect(result.summaryTable).toContain(`${versionA.id} vs ${versionB.id}`);

        expect(runner.runComparison).toHaveBeenCalledTimes(1);
    });
});

interface ILeafOverrides {
    readonly runLabel: string;
    readonly strategyVersionId: number;
    readonly tradeCount: number;
    readonly netPnlUsdt: string;
    readonly profitFactor: string;
    readonly sharpeAnnualized: string;
}

function buildLeafReport(overrides: ILeafOverrides) {
    return {
        runLabel: overrides.runLabel,
        strategyVersionId: overrides.strategyVersionId,
        strategyName: 'mock',
        strategyVersion: 1,
        fromUtcDate: '2025-01-01',
        toUtcDate: '2025-04-01',
        tradeCount: overrides.tradeCount,
        winCount: Math.max(0, Math.floor(overrides.tradeCount / 2)),
        lossCount: overrides.tradeCount - Math.max(0, Math.floor(overrides.tradeCount / 2)),
        winRatePct: '50.00',
        grossPnlUsdt: overrides.netPnlUsdt,
        feesUsdt: '0',
        fundingUsdt: '0',
        slippageCostUsdt: '0',
        netPnlUsdt: overrides.netPnlUsdt,
        returnPct: '0',
        profitFactor: overrides.profitFactor,
        avgHoldMs: 600000,
        maxDrawdownPct: '0',
        maxDrawdownDurationDays: 0,
        sharpeAnnualized: overrides.sharpeAnnualized,
        sortinoAnnualized: overrides.sharpeAnnualized,
        skippedTriggerCount: 0,
        rejectedByGateCount: 0,
        missedLimitFillCount: 0,
        lowFidelityTradeCount: 0,
        equityCurve: [],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades: [],
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { relative as relativePath, resolve as resolvePath } from 'path';

import { BACKTEST_ARTEFACT_ROOT } from '../../backtest/const/backtestConsts';
import { ComparisonRunnerService, IComparisonRunRequest } from '../../backtest/service/ComparisonRunnerService';
import { WalkForwardSplitModeEnum } from '../../backtest/enum/WalkForwardSplitModeEnum';
import { IComparisonReport } from '../../backtest/interface';
import { IWalkForwardSplitPolicy } from '../../backtest/interface/IWalkForwardSplitPolicy';
import { IPairwiseBootstrapResult } from '../../backtest/interface/IPairwiseBootstrapResult';
import { MS_PER_DAY } from '../../common/const/timeConsts';
import { Money, MoneyValue } from '../../common/utils/money';
import { StrategyVersionEntity } from '../entity/StrategyVersionEntity';
import { ArtefactPathOutsideRootException } from '../../promotion/exception';
import { CompareCommandException } from '../exception/CompareCommandException';
import { ComparisonReportRepository } from '../repository/ComparisonReportRepository';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';
import { parseFlagMap, requireFlag } from './cliArgs';
import {
    DEFAULT_ALLOCATED_CAPITAL_USDT,
    DEFAULT_LATENCY_MS,
    DEFAULT_OOS_BARS,
    DEFAULT_STEP_BARS,
    DEFAULT_TRAIN_BARS,
    DEFAULT_VALIDATION_BARS,
} from './const/compareCliConsts';

// `strategy compare` (ADR 0017 §2.6 + ADR 0019 §2.5). Resolves the candidate set,
// invokes ComparisonRunnerService over the requested date range under the requested split
// policy, writes the full IComparisonReport JSON to disk under BACKTEST_ARTEFACT_DIR, and
// persists a slim `comparison_reports` row whose `artefact_uri` points at the artefact.
//
// Defaults (per W7 brief):
//   - split policy:   60-day train / 14-day validation / 14-day OOS / 14-day step, rolling
//   - artefact dir:   ./var/backtest-artefacts/ (or BACKTEST_ARTEFACT_DIR env override)
//   - allocated cap:  10000 USDT (M7 RunBacktestCommand default)
//   - latency:        100 ms
//
// Idempotency for --label collisions: the artefact filename is
// `comparison-${runLabel}-${timestamp}.json`. If a file at that exact path already exists
// (extremely unlikely with the second-resolution timestamp suffix) we refuse with a clear
// error rather than overwrite — silently clobbering a prior artefact would break the
// strategy_versions.promotion_report_id back-reference of any past promotion.

export interface ICompareArgs {
    readonly fromMs: number;
    readonly toMs: number;
    readonly versionSpecs: readonly IVersionSpec[];
    readonly splitPolicy: IWalkForwardSplitPolicy;
    readonly runLabel: string;
}

export type IVersionSpec = { readonly kind: 'id'; readonly id: number } | { readonly kind: 'name_version'; readonly name: string; readonly version: number };

export interface ICompareCommandResult {
    readonly reportId: number;
    readonly artefactPath: string;
    readonly summaryTable: string;
}

export class CompareCommand {
    private readonly logger = new Logger(CompareCommand.name);

    constructor(
        private readonly comparisonRunner: ComparisonRunnerService,
        private readonly comparisonReportRepository: ComparisonReportRepository,
        private readonly strategyVersionRepository: StrategyVersionRepository,
    ) {}

    async execute(args: ICompareArgs): Promise<ICompareCommandResult> {
        const candidates = await this.resolveCandidates(args.versionSpecs);

        const request: IComparisonRunRequest = {
            runId: randomUUID(),
            rangeFromMs: args.fromMs,
            rangeToMs: args.toMs,
            splitPolicy: args.splitPolicy,
            candidates,
            runLabel: args.runLabel,
            allocatedCapitalUsdt: DEFAULT_ALLOCATED_CAPITAL_USDT,
            latencyMs: DEFAULT_LATENCY_MS,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: true,
        };

        this.logger.log(`strategy compare runLabel=${args.runLabel} versions=${candidates.map((c) => c.id).join(',')} range=[${args.fromMs}, ${args.toMs})`);

        const report = await this.comparisonRunner.runComparison(request);

        const artefactPath = await writeArtefact(args.runLabel, report);
        const summary = buildSummary(report);
        const persisted = await this.comparisonReportRepository.createReport({
            runLabel: args.runLabel,
            fromMs: String(args.fromMs),
            toMs: String(args.toMs),
            splitPolicy: args.splitPolicy as unknown as Record<string, unknown>,
            folds: report.folds as unknown as unknown[],
            versionIds: candidates.map((c) => c.id),
            summary: summary as unknown as Record<string, unknown>,
            artefactUri: artefactPath,
        });

        const summaryTable = renderSummaryTable(report);

        return { reportId: persisted.id, artefactPath, summaryTable };
    }

    private async resolveCandidates(specs: readonly IVersionSpec[]): Promise<StrategyVersionEntity[]> {
        const resolved: StrategyVersionEntity[] = [];

        for (const spec of specs) {
            if (spec.kind === 'id') {
                const row = await this.strategyVersionRepository.findById(spec.id);

                if (row === null) {
                    throw new CompareCommandException(`compare: strategy version id=${spec.id} not found`);
                }

                resolved.push(row);
                continue;
            }

            const row = await this.strategyVersionRepository.findByNameAndVersion(spec.name, spec.version);

            if (row === null) {
                throw new CompareCommandException(`compare: strategy version ${spec.name}:${spec.version} not found`);
            }

            resolved.push(row);
        }

        return resolved;
    }
}

// --- Argument parsing (exported for unit tests) ------------------------------

export function parseCompareArgs(argv: readonly string[]): ICompareArgs {
    const flags = parseFlagMap(argv);

    const fromIso = requireFlag(flags, 'from');
    const toIso = requireFlag(flags, 'to');
    const versionsRaw = requireFlag(flags, 'versions');
    const splitPolicyRaw = flags.get('split-policy') ?? 'default';
    const runLabel = flags.get('label') ?? `compare-${Date.now()}`;

    const fromMs = parseIso8601(fromIso, 'from');
    const toMs = parseIso8601(toIso, 'to');

    if (toMs <= fromMs) {
        throw new Error(`--to (${toIso}) must be after --from (${fromIso})`);
    }

    return {
        fromMs,
        toMs,
        versionSpecs: parseVersionsArg(versionsRaw),
        splitPolicy: parseSplitPolicy(splitPolicyRaw),
        runLabel,
    };
}

function parseIso8601(value: string, flagName: string): number {
    const ms = Date.parse(value);

    if (Number.isNaN(ms)) {
        throw new Error(`--${flagName} '${value}' is not a valid ISO-8601 timestamp`);
    }

    return ms;
}

// Accepts either `id,id,id` (all numeric) or `name:version,name:version,...`. Mixing the
// two forms is rejected so the parser stays unambiguous.
export function parseVersionsArg(raw: string): IVersionSpec[] {
    const tokens = raw
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

    if (tokens.length === 0) {
        throw new Error('--versions must list at least one version');
    }

    const hasColon = tokens.some((token) => token.includes(':'));
    const allColon = tokens.every((token) => token.includes(':'));

    if (hasColon && !allColon) {
        throw new Error('--versions must be either all numeric ids OR all name:version pairs, not a mix');
    }

    if (allColon) {
        return tokens.map((token) => {
            const [name, versionRaw] = token.split(':');

            if (name === undefined || name.length === 0 || versionRaw === undefined) {
                throw new Error(`--versions token '${token}' is not name:version`);
            }

            const version = Number(versionRaw);

            if (!Number.isInteger(version) || version <= 0) {
                throw new Error(`--versions token '${token}' has non-positive integer version`);
            }

            return { kind: 'name_version', name, version };
        });
    }

    return tokens.map((token) => {
        const id = Number(token);

        if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`--versions token '${token}' is not a positive integer id`);
        }

        return { kind: 'id', id };
    });
}

export function parseSplitPolicy(raw: string): IWalkForwardSplitPolicy {
    if (raw === 'default') {
        return {
            trainBars: DEFAULT_TRAIN_BARS,
            validationBars: DEFAULT_VALIDATION_BARS,
            oosBars: DEFAULT_OOS_BARS,
            stepBars: DEFAULT_STEP_BARS,
            mode: WalkForwardSplitModeEnum.ROLLING,
        };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`--split-policy is not valid JSON: ${(cause as Error).message}`);
    }

    if (parsed === null || typeof parsed !== 'object') {
        throw new Error('--split-policy JSON must be an object');
    }

    const obj = parsed as Record<string, unknown>;
    const mode = obj['mode'] === 'expanding' ? WalkForwardSplitModeEnum.EXPANDING : WalkForwardSplitModeEnum.ROLLING;

    return {
        trainBars: requirePositiveInt(obj['trainBars'], 'trainBars'),
        validationBars: requirePositiveInt(obj['validationBars'], 'validationBars'),
        oosBars: requirePositiveInt(obj['oosBars'], 'oosBars'),
        stepBars: requirePositiveInt(obj['stepBars'], 'stepBars'),
        mode,
    };
}

function requirePositiveInt(value: unknown, name: string): number {
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`--split-policy.${name} must be a positive integer`);
    }

    return value as number;
}

// --- Artefact writer ---------------------------------------------------------

// R2-M1: writer resolves the destination against the module-resolved
// BACKTEST_ARTEFACT_ROOT and asserts containment via `path.relative`. A
// `runLabel` containing `..` (or any segment that escapes the root after
// resolution) is rejected as an ArtefactPathOutsideRootException — guarding
// against an operator typo / compromised env producing artefacts in arbitrary
// writable locations.
export async function writeArtefact(runLabel: string, report: IComparisonReport): Promise<string> {
    await fs.mkdir(BACKTEST_ARTEFACT_ROOT, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `comparison-${sanitizeLabel(runLabel)}-${ts}.json`;
    const path = resolvePath(BACKTEST_ARTEFACT_ROOT, filename);

    assertWithinArtefactRoot(path);

    const serialised = JSON.stringify(serialiseReport(report), null, 2);

    // 'wx' = fail if the path exists. Atomically refuses to silently overwrite a previous
    // artefact with the same label+timestamp (extremely unlikely but possible in tight
    // automation loops on the same second).
    const handle = await fs.open(path, 'wx');

    try {
        await handle.writeFile(serialised, 'utf8');
    } finally {
        await handle.close();
    }

    return path;
}

function assertWithinArtefactRoot(candidate: string): void {
    const rel = relativePath(BACKTEST_ARTEFACT_ROOT, candidate);

    if (rel.startsWith('..') || rel === '' || resolvePath(BACKTEST_ARTEFACT_ROOT, rel) !== candidate) {
        throw new ArtefactPathOutsideRootException(`artefact path '${candidate}' resolves outside BACKTEST_ARTEFACT_ROOT='${BACKTEST_ARTEFACT_ROOT}'`);
    }
}

function sanitizeLabel(label: string): string {
    return label.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Maps are not JSON-serialisable by default — `JSON.stringify(new Map())` yields `{}`.
// We expand `perFoldReports`, `regimeBreakdown`, `tailRiskByVersion`, and per-event
// `outcomesByVersion` into [key, value] tuple arrays so the artefact round-trips through
// PromotionGateService.loadReportArtefact (which already accepts the tuple form).
function serialiseReport(report: IComparisonReport): Record<string, unknown> {
    const perFoldReports: Array<[string, unknown]> = [];

    for (const [key, leaf] of report.perFoldReports.entries()) {
        perFoldReports.push([key, leaf]);
    }

    const eventOutcomes = report.eventOutcomes.map((outcome) => ({
        eventId: outcome.eventId,
        symbol: outcome.symbol,
        triggerTs: outcome.triggerTs,
        regime: outcome.regime,
        flowType: outcome.flowType,
        outcomesByVersion: Array.from(outcome.outcomesByVersion.entries()),
    }));

    const regimeBreakdown: Array<[number, unknown]> | null =
        report.regimeBreakdown === null
            ? null
            : Array.from(report.regimeBreakdown.entries()).map(([versionId, metrics]) => [versionId, { buckets: Array.from(metrics.buckets.entries()) }]);

    const tailRiskByVersion: Array<[number, unknown]> | null = report.tailRiskByVersion === null ? null : Array.from(report.tailRiskByVersion.entries());

    return {
        runId: report.runId,
        rangeFromMs: report.rangeFromMs,
        rangeToMs: report.rangeToMs,
        splitPolicy: report.splitPolicy,
        folds: report.folds,
        versions: report.versions,
        perFoldReports,
        eventOutcomes,
        pairwiseStats: report.pairwiseStats,
        regimeBreakdown,
        tailRiskByVersion,
        multipleComparisonNote: report.multipleComparisonNote,
        lowFidelityTradeCount: report.lowFidelityTradeCount,
    };
}

// --- Slim DB summary ---------------------------------------------------------

interface IPersistedSummary {
    readonly versions: ReadonlyArray<{
        readonly versionId: number;
        readonly name: string;
        readonly version: number;
        readonly oosTradeCount: number;
        readonly oosNetPnlUsdt: string;
        readonly oosProfitFactor: string;
    }>;
    readonly pairwiseWinners: ReadonlyArray<{
        readonly versionA: number;
        readonly versionB: number;
        readonly winner: 'A' | 'B' | 'tie' | 'inconclusive';
    }>;
    readonly lowFidelityTradeCount: number;
    readonly foldCount: number;
}

function buildSummary(report: IComparisonReport): IPersistedSummary {
    const versions = report.versions.map((versionRef) => {
        const oosAgg = aggregateOosCells(report, versionRef.versionId);

        return {
            versionId: versionRef.versionId,
            name: versionRef.name,
            version: versionRef.version,
            oosTradeCount: oosAgg.tradeCount,
            oosNetPnlUsdt: oosAgg.netPnlUsdt,
            oosProfitFactor: oosAgg.profitFactor,
        };
    });

    const pairwiseWinners = (report.pairwiseStats ?? []).map((pair) => ({
        versionA: pair.versionA,
        versionB: pair.versionB,
        winner: pair.outcome === 'conclusive' ? pair.winner : ('inconclusive' as const),
    }));

    return {
        versions,
        pairwiseWinners,
        lowFidelityTradeCount: report.lowFidelityTradeCount,
        foldCount: report.folds.length,
    };
}

interface IOosAggregate {
    readonly tradeCount: number;
    readonly netPnlUsdt: string;
    readonly profitFactor: string;
}

// R1-H4 fix: money arithmetic uses `Money` (decimal.js) so the slim DB summary preserves
// precision identical to the rest of the engine. Profit factor remains a `number` ratio
// at the boundary, computed from decimal grossWin / grossLoss; it is the only numeric
// quantity that crosses out of the decimal domain.
function aggregateOosCells(report: IComparisonReport, versionId: number): IOosAggregate {
    let tradeCount = 0;
    let netPnlUsdtSum = new Money(0);
    let grossWin = new Money(0);
    let grossLoss = new Money(0);

    for (const [key, leaf] of report.perFoldReports.entries()) {
        const parts = key.split(':');

        if (parts.length !== 3 || Number(parts[0]) !== versionId || parts[2] !== 'oos') {
            continue;
        }

        tradeCount += leaf.tradeCount;

        if (isFiniteDecimalString(leaf.netPnlUsdt)) {
            netPnlUsdtSum = netPnlUsdtSum.plus(new Money(leaf.netPnlUsdt));
        }

        for (const trade of leaf.trades) {
            if (!isFiniteDecimalString(trade.netPnlUsdt)) {
                continue;
            }

            const pnl = new Money(trade.netPnlUsdt);

            if (pnl.greaterThan(0)) {
                grossWin = grossWin.plus(pnl);
            } else {
                grossLoss = grossLoss.plus(pnl.abs());
            }
        }
    }

    const pf = profitFactorString(grossWin, grossLoss);

    return { tradeCount, netPnlUsdt: netPnlUsdtSum.toFixed(4), profitFactor: pf };
}

function profitFactorString(grossWin: MoneyValue, grossLoss: MoneyValue): string {
    if (grossLoss.isZero()) {
        return grossWin.isZero() ? '0' : 'Infinity';
    }

    return grossWin.dividedBy(grossLoss).toFixed(4);
}

function isFiniteDecimalString(raw: string): boolean {
    if (raw === 'Infinity' || raw === '-Infinity' || raw === 'NaN') {
        return false;
    }

    try {
        const value = new Money(raw);
        return value.isFinite();
    } catch {
        return false;
    }
}

// --- ASCII summary table -----------------------------------------------------

function renderSummaryTable(report: IComparisonReport): string {
    const header = '| versionId | name:version | trades | expectancyR | PF      | Sharpe   |';
    const sep = '|-----------|--------------|--------|-------------|---------|----------|';
    const rows: string[] = [header, sep];

    for (const versionRef of report.versions) {
        const cells = collectOosCells(report, versionRef.versionId);
        const trades = cells.reduce((sum, cell) => sum + cell.tradeCount, 0);
        const meanPf = averageNumeric(cells.map((c) => c.profitFactor));
        const meanSharpe = averageNumeric(cells.map((c) => c.sharpeAnnualized));
        const expectancyR = computeExpectancyR(report, versionRef.versionId);

        rows.push(
            `| ${pad(String(versionRef.versionId), 9)} | ${pad(`${versionRef.name}:${versionRef.version}`, 12)} | ${pad(String(trades), 6)} | ${pad(expectancyR.toFixed(4), 11)} | ${pad(meanPf.toFixed(3), 7)} | ${pad(meanSharpe.toFixed(4), 8)} |`,
        );
    }

    if (report.pairwiseStats !== null && report.pairwiseStats.length > 0) {
        rows.push('');
        rows.push('Pairwise winners:');

        for (const pair of report.pairwiseStats) {
            rows.push(`  ${pair.versionA} vs ${pair.versionB} → ${describePairWinner(pair)}`);
        }
    }

    const days = ((report.rangeToMs - report.rangeFromMs) / MS_PER_DAY).toFixed(1);
    rows.push('');
    rows.push(`folds=${report.folds.length} rangeDays=${days} lowFidelityTrades=${report.lowFidelityTradeCount}`);

    return rows.join('\n');
}

interface IOosCellMetric {
    readonly tradeCount: number;
    readonly profitFactor: number;
    readonly sharpeAnnualized: number;
}

function collectOosCells(report: IComparisonReport, versionId: number): IOosCellMetric[] {
    const result: IOosCellMetric[] = [];

    for (const [key, leaf] of report.perFoldReports.entries()) {
        const parts = key.split(':');

        if (parts.length !== 3 || Number(parts[0]) !== versionId || parts[2] !== 'oos') {
            continue;
        }

        result.push({
            tradeCount: leaf.tradeCount,
            profitFactor: leaf.profitFactor === 'Infinity' ? Number.POSITIVE_INFINITY : Number(leaf.profitFactor),
            sharpeAnnualized: Number(leaf.sharpeAnnualized),
        });
    }

    return result;
}

function computeExpectancyR(report: IComparisonReport, versionId: number): number {
    let sum = 0;
    let count = 0;

    for (const outcome of report.eventOutcomes) {
        const record = outcome.outcomesByVersion.get(versionId);

        if (record === undefined) {
            continue;
        }

        sum += record.rPerUnitRisk ?? 0;
        count += 1;
    }

    return count === 0 ? 0 : sum / count;
}

function averageNumeric(values: readonly number[]): number {
    const finite = values.filter((v) => Number.isFinite(v));

    if (finite.length === 0) {
        return 0;
    }

    return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

function describePairWinner(pair: IPairwiseBootstrapResult): string {
    if (pair.outcome === 'inconclusive') {
        return `inconclusive (${pair.reason})`;
    }

    const winnerId = pair.winner === 'A' ? String(pair.versionA) : pair.winner === 'B' ? String(pair.versionB) : 'tie';

    return `winner=${winnerId} CI95=[${pair.ci95Low}, ${pair.ci95High}]`;
}

function pad(value: string, width: number): string {
    if (value.length >= width) {
        return value;
    }

    return value + ' '.repeat(width - value.length);
}

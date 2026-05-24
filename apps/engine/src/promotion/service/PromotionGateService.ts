import { IBacktestReport, IBacktestTradeResult, RegimeLabelEnum, StrategyDirectionEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { relative as relativePath, resolve as resolvePath } from 'path';

import { BACKTEST_ARTEFACT_ROOT } from '../../backtest/const/backtestConsts';
import { MS_PER_WEEK } from '../../common/const/timeConsts';
import { Money } from '../../common/utils/money';
import { ComparisonFoldCellKey, IComparisonReport } from '../../backtest/interface';
import { IPairwiseBootstrapResult } from '../../backtest/interface/IPairwiseBootstrapResult';
import { IRegimeBucket, IRegimeMetrics } from '../../backtest/interface/IRegimeMetrics';
import { ComparisonReportEntity } from '../../strategy/entity/ComparisonReportEntity';
import { ComparisonReportRepository } from '../../strategy/repository/ComparisonReportRepository';
import { StrategyVersionEntity } from '../../strategy/entity/StrategyVersionEntity';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import {
    DROP_BEST_TRIM_PCT,
    MAX_DD_TOLERANCE_PCT,
    MAX_SYMBOL_CONCENTRATION_PCT,
    MAX_WEEK_CONCENTRATION_PCT,
    MIN_PROFIT_FACTOR,
    MIN_REGIME_TRADES,
    MIN_SHADOW_DAYS,
    MIN_TOTAL_TRADES,
    REGIME_TARGETS_BY_DIRECTION,
    WORST_DAY_LOSS_TOLERANCE_PCT,
} from '../const/promotionGateConsts';
import { ArtefactPathOutsideRootException } from '../exception/ArtefactPathOutsideRootException';
import { PromotionGateInternalException } from '../exception/PromotionGateInternalException';
import { IPromotionCriterionFailure, IPromotionGateOutcome, PromotionInconclusiveReason } from '../interface/IPromotionGateOutcome';

// The promotion gate (ADR 0019). Evaluates the 12 all-of criteria against a
// stored IComparisonReport for a candidate version vs. the **current active
// baseline at evaluation time** (ADR 0019 §4 alt 4 — re-fetch the active row
// at promote time, not the one captured when the report was generated).
//
// W6 scope:
//   - Criteria 1, 2, 3, 4, 5, 6, 8, 10, 11, 12 — fully evaluated from stored
//     comparison data (some pure-numeric like 8 derive a trimmed series).
//   - Criteria 7 (doubled slippage) & 9 (stress windows) — DEFERRED to W6.1.
//     They require re-running BacktestRunnerService with stress configs which
//     is its own orchestration concern. Until W6.1 lands the gate returns
//     `severity='deferred'` for these two indices and the overall decision is
//     downgraded to `inconclusive` with reason='robustness_pending' to prevent
//     promotion-by-omission. Deferred to W6.1 — robustness re-runs (ADR 0019
//     §2.4, criteria 7 + 9) will invoke stress-run robustness checks and flip
//     severity to a real block/inconclusive verdict.
//
// The gate NEVER allows a `--force` override (ADR 0019 §2.1). Callers receive a
// structured outcome; PromotionService translates a non-'promote' outcome into
// PromotionRejectedException.
@Injectable()
export class PromotionGateService {
    private readonly logger = new Logger(PromotionGateService.name);

    constructor(
        private readonly strategyVersionRepository: StrategyVersionRepository,
        private readonly comparisonReportRepository: ComparisonReportRepository,
    ) {}

    async evaluate(versionId: number, reportId: number): Promise<IPromotionGateOutcome> {
        const candidate = await this.requireCandidate(versionId);
        const reportRow = await this.requireReportRow(reportId);
        const baseline = await this.findActiveBaseline(candidate.name, candidate.id);
        const report = await this.loadReportArtefact(reportRow);

        const passed: number[] = [];
        const failed: IPromotionCriterionFailure[] = [];

        this.runCriterion(passed, failed, 1, 'oos_positive_expectancy', () => this.checkOosPositiveExpectancy(report, candidate.id));
        this.runCriterion(passed, failed, 2, 'oos_profit_factor', () => this.checkOosProfitFactor(report, candidate.id));
        this.runCriterion(passed, failed, 3, 'max_drawdown', () => this.checkMaxDrawdown(report, candidate.id));
        this.runCriterion(passed, failed, 4, 'worst_day_loss', () => this.checkWorstDayLoss(report, candidate.id));
        this.runCriterion(passed, failed, 5, 'statistical_significance', () => this.checkStatisticalSignificance(report, candidate.id, baseline));
        this.runCriterion(passed, failed, 6, 'sample_sufficiency', () => this.checkSampleSufficiency(report, candidate));
        this.runCriterion(passed, failed, 7, 'robustness_slippage_stress', () => this.checkDeferredRobustness('slippage_stress_doubled'));
        this.runCriterion(passed, failed, 8, 'robustness_drop_best', () => this.checkDropBestRobustness(report, candidate.id));
        this.runCriterion(passed, failed, 9, 'robustness_stress_windows', () => this.checkDeferredRobustness('stress_windows'));
        this.runCriterion(passed, failed, 10, 'concentration', () => this.checkConcentration(report, candidate.id));
        this.runCriterion(passed, failed, 11, 'regime_targeting', () => this.checkRegimeTargeting(report, candidate, baseline));
        this.runCriterion(passed, failed, 12, 'low_fidelity_dependence', () => this.checkLowFidelityDependence(report, candidate.id));

        const decision = this.classifyDecision(failed);
        const inconclusiveReason = this.deriveInconclusiveReason(failed, decision);

        this.logger.log(`promotion gate version=${versionId} report=${reportId} decision=${decision} passed=${passed.length} failed=${failed.length}`);

        return {
            versionId,
            reportId,
            decision,
            passedCriteria: passed,
            failedCriteria: failed,
            inconclusiveReason,
            evaluatedAt: new Date(),
        };
    }

    private async requireCandidate(versionId: number): Promise<StrategyVersionEntity> {
        const candidate = await this.strategyVersionRepository.findById(versionId);

        if (candidate === null) {
            throw new PromotionGateInternalException(`PromotionGateService: candidate version ${versionId} not found`);
        }

        return candidate;
    }

    private async requireReportRow(reportId: number): Promise<ComparisonReportEntity> {
        const row = await this.comparisonReportRepository.findById(reportId);

        if (row === null) {
            throw new PromotionGateInternalException(`PromotionGateService: comparison report ${reportId} not found`);
        }

        return row;
    }

    // Re-fetch the **current** active baseline by name at evaluation time. The
    // baseline that was active when the report was generated may have been
    // archived since; the gate compares against what live is reading **now**
    // (ADR 0019 §4 alt 4 / §2.5). Returns null when the candidate is the very
    // first row for its name.
    private async findActiveBaseline(name: string, candidateId: number): Promise<StrategyVersionEntity | null> {
        const actives = await this.strategyVersionRepository.findActive();
        const sameName = actives.filter((row) => row.name === name && row.id !== candidateId);

        return sameName[0] ?? null;
    }

    // Load the full IComparisonReport JSON artefact from disk. The on-disk form
    // is whatever ComparisonRunnerService.W4 writes (a future writer wave); the
    // loader accepts both the in-memory Map form (when callers pass a hydrated
    // object) and the JSON-array form (Map entries serialised as [key, value]
    // tuples). Test fixtures use the array form directly.
    private async loadReportArtefact(row: ComparisonReportEntity): Promise<IComparisonReport> {
        // R2-M1: path-resolve the persisted artefact_uri and assert containment
        // under BACKTEST_ARTEFACT_ROOT before reading. A tampered DB row whose
        // artefact_uri points outside the configured root (or escapes via `..`)
        // is refused via ArtefactPathOutsideRootException — `fs.readFile` is
        // never invoked with an attacker-supplied path.
        const resolved = resolvePath(row.artefactUri);
        const rel = relativePath(BACKTEST_ARTEFACT_ROOT, resolved);

        if (rel.startsWith('..') || resolvePath(BACKTEST_ARTEFACT_ROOT, rel) !== resolved) {
            throw new ArtefactPathOutsideRootException(
                `comparison_reports.artefact_uri='${row.artefactUri}' resolves outside BACKTEST_ARTEFACT_ROOT='${BACKTEST_ARTEFACT_ROOT}'`,
            );
        }

        const raw = await fs.readFile(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;

        return this.hydrateReport(parsed);
    }

    private hydrateReport(parsed: Record<string, unknown>): IComparisonReport {
        const perFold = this.hydratePerFoldReports(parsed['perFoldReports']);
        const eventOutcomes = (parsed['eventOutcomes'] as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];

        return {
            runId: String(parsed['runId'] ?? ''),
            rangeFromMs: Number(parsed['rangeFromMs'] ?? 0),
            rangeToMs: Number(parsed['rangeToMs'] ?? 0),
            splitPolicy: parsed['splitPolicy'] as IComparisonReport['splitPolicy'],
            folds: (parsed['folds'] as IComparisonReport['folds']) ?? [],
            versions: (parsed['versions'] as IComparisonReport['versions']) ?? [],
            perFoldReports: perFold,
            eventOutcomes: eventOutcomes.map((entry) => ({
                eventId: String(entry['eventId']),
                symbol: String(entry['symbol']),
                triggerTs: Number(entry['triggerTs']),
                regime: entry['regime'] as RegimeLabelEnum,
                flowType: entry['flowType'] as IComparisonReport['eventOutcomes'][number]['flowType'],
                outcomesByVersion: this.hydrateOutcomesByVersion(entry['outcomesByVersion']),
            })),
            pairwiseStats: (parsed['pairwiseStats'] as readonly IPairwiseBootstrapResult[] | null) ?? null,
            regimeBreakdown: this.hydrateRegimeBreakdown(parsed['regimeBreakdown']),
            tailRiskByVersion: null,
            multipleComparisonNote: (parsed['multipleComparisonNote'] as string | null) ?? null,
            promotionDecisions: null,
            lowFidelityTradeCount: Number(parsed['lowFidelityTradeCount'] ?? 0),
        };
    }

    private hydratePerFoldReports(value: unknown): Map<ComparisonFoldCellKey, IBacktestReport> {
        const result: Map<ComparisonFoldCellKey, IBacktestReport> = new Map();

        if (Array.isArray(value)) {
            for (const entry of value as Array<[ComparisonFoldCellKey, IBacktestReport]>) {
                result.set(entry[0], entry[1]);
            }

            return result;
        }

        if (value !== null && typeof value === 'object') {
            for (const [key, report] of Object.entries(value as Record<string, IBacktestReport>)) {
                result.set(key as ComparisonFoldCellKey, report);
            }
        }

        return result;
    }

    private hydrateOutcomesByVersion(value: unknown): IComparisonReport['eventOutcomes'][number]['outcomesByVersion'] {
        type OutcomeRecord = IComparisonReport['eventOutcomes'][number]['outcomesByVersion'] extends Map<number, infer V> ? V : never;
        const result: Map<number, OutcomeRecord> = new Map();

        if (Array.isArray(value)) {
            for (const [versionId, record] of value as Array<[number | string, OutcomeRecord]>) {
                result.set(Number(versionId), record);
            }
        } else if (value !== null && typeof value === 'object') {
            for (const [key, record] of Object.entries(value as Record<string, OutcomeRecord>)) {
                result.set(Number(key), record);
            }
        }

        return result;
    }

    private hydrateRegimeBreakdown(value: unknown): ReadonlyMap<number, IRegimeMetrics> | null {
        if (value === null || value === undefined) {
            return null;
        }

        const result: Map<number, IRegimeMetrics> = new Map();
        const entries: Array<[unknown, unknown]> = Array.isArray(value) ? (value as Array<[unknown, unknown]>) : Object.entries(value as Record<string, unknown>);

        for (const [versionKey, metricsRaw] of entries) {
            const buckets: Map<RegimeLabelEnum, IRegimeBucket> = new Map();
            const bucketEntries: Array<[unknown, unknown]> = Array.isArray((metricsRaw as { buckets?: unknown }).buckets)
                ? ((metricsRaw as { buckets: Array<[unknown, unknown]> }).buckets)
                : Object.entries((metricsRaw as { buckets?: Record<string, unknown> }).buckets ?? {});

            for (const [regime, bucket] of bucketEntries) {
                buckets.set(regime as RegimeLabelEnum, bucket as IRegimeBucket);
            }

            result.set(Number(versionKey), { buckets });
        }

        return result;
    }

    // Wraps each criterion check; a thrown error inside a checker is reported as
    // a 'block' failure so a buggy criterion never silently flips to 'pass'.
    private runCriterion(passed: number[], failed: IPromotionCriterionFailure[], index: number, name: string, check: () => IPromotionCriterionFailure | null): void {
        const failure = this.safeCheck(index, name, check);

        if (failure === null) {
            passed.push(index);
            return;
        }

        failed.push(failure);
    }

    private safeCheck(index: number, name: string, check: () => IPromotionCriterionFailure | null): IPromotionCriterionFailure | null {
        try {
            return check();
        } catch (cause) {
            this.logger.warn(`promotion gate criterion ${index} (${name}) threw: ${(cause as Error).message}`);
            return { index, name, threshold: 'no_error', observed: `error: ${(cause as Error).message}`, severity: 'block' };
        }
    }

    private classifyDecision(failed: readonly IPromotionCriterionFailure[]): IPromotionGateOutcome['decision'] {
        if (failed.length === 0) {
            return 'promote';
        }

        const hasBlock = failed.some((failure) => failure.severity === 'block');

        if (hasBlock) {
            return 'reject';
        }

        return 'inconclusive';
    }

    private deriveInconclusiveReason(failed: readonly IPromotionCriterionFailure[], decision: IPromotionGateOutcome['decision']): PromotionInconclusiveReason | undefined {
        if (decision !== 'inconclusive') {
            return undefined;
        }

        // Robustness-pending takes priority — it represents work that has not been
        // executed at all, distinct from a sample that ran but came up short.
        if (failed.some((failure) => failure.severity === 'deferred')) {
            return 'robustness_pending';
        }

        if (failed.some((failure) => failure.index === 5)) {
            return 'statistical';
        }

        return 'sample_sufficiency';
    }

    // --- Criterion 1: net positive expectancy on every OOS fold. -------------

    private checkOosPositiveExpectancy(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const oosReports = collectOosReports(report, versionId);

        if (oosReports.length === 0) {
            return { index: 1, name: 'oos_positive_expectancy', threshold: '>0 every OOS fold', observed: 'no OOS folds', severity: 'block' };
        }

        for (const cell of oosReports) {
            const netPnl = new Money(cell.report.netPnlUsdt);

            if (!netPnl.greaterThan(0)) {
                return { index: 1, name: 'oos_positive_expectancy', threshold: '>0 every OOS fold', observed: `fold ${cell.foldIndex}: netPnl=${netPnl.toFixed()}`, severity: 'block' };
            }
        }

        return null;
    }

    // --- Criterion 2: OOS profit factor >= MIN_PROFIT_FACTOR every fold. -----

    private checkOosProfitFactor(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const oosReports = collectOosReports(report, versionId);

        for (const cell of oosReports) {
            const pf = parseProfitFactor(cell.report.profitFactor);

            if (pf < MIN_PROFIT_FACTOR) {
                return { index: 2, name: 'oos_profit_factor', threshold: `>= ${MIN_PROFIT_FACTOR}`, observed: `fold ${cell.foldIndex}: pf=${cell.report.profitFactor}`, severity: 'block' };
            }
        }

        return null;
    }

    // --- Criterion 3: max OOS drawdown within tolerance. ---------------------

    private checkMaxDrawdown(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const oosReports = collectOosReports(report, versionId);
        let worst = new Money(0);
        let worstFold = -1;

        for (const cell of oosReports) {
            const dd = new Money(cell.report.maxDrawdownPct);

            if (dd.greaterThan(worst)) {
                worst = dd;
                worstFold = cell.foldIndex;
            }
        }

        if (worst.greaterThan(MAX_DD_TOLERANCE_PCT)) {
            return { index: 3, name: 'max_drawdown', threshold: `<= ${MAX_DD_TOLERANCE_PCT}%`, observed: `fold ${worstFold}: dd=${worst.toFixed()}%`, severity: 'block' };
        }

        return null;
    }

    // --- Criterion 4: worst single-day loss is survivable. -------------------
    //
    // The daily equity curve carries `dailyReturnPct` on every point. We treat
    // the most negative daily return across all OOS folds as the worst day; if
    // its absolute value exceeds WORST_DAY_LOSS_TOLERANCE_PCT, the candidate
    // fails.

    private checkWorstDayLoss(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const oosReports = collectOosReports(report, versionId);
        let worst = new Money(0);
        let worstFold = -1;

        for (const cell of oosReports) {
            for (const point of cell.report.equityCurve) {
                const ret = new Money(point.dailyReturnPct);

                if (ret.lessThan(worst)) {
                    worst = ret;
                    worstFold = cell.foldIndex;
                }
            }
        }

        const absWorst = worst.abs();

        if (absWorst.greaterThan(WORST_DAY_LOSS_TOLERANCE_PCT)) {
            return { index: 4, name: 'worst_day_loss', threshold: `<= ${WORST_DAY_LOSS_TOLERANCE_PCT}% (abs)`, observed: `fold ${worstFold}: worst day=${worst.toFixed()}%`, severity: 'block' };
        }

        return null;
    }

    // --- Criterion 5: statistical significance vs current active. ------------

    private checkStatisticalSignificance(report: IComparisonReport, versionId: number, baseline: StrategyVersionEntity | null): IPromotionCriterionFailure | null {
        if (baseline === null) {
            // No incumbent — the statistical test has no peer. We treat this as
            // 'inconclusive' rather than auto-pass so an empty-history promotion
            // is impossible without a real comparison.
            return { index: 5, name: 'statistical_significance', threshold: 'paired bootstrap CI excludes zero', observed: 'no active baseline to compare against', severity: 'inconclusive' };
        }

        const pair = findPairwiseResult(report.pairwiseStats, versionId, baseline.id);

        if (pair === null) {
            return { index: 5, name: 'statistical_significance', threshold: 'paired bootstrap CI excludes zero', observed: 'pairwise stats missing for (candidate, baseline)', severity: 'inconclusive' };
        }

        if (pair.outcome === 'inconclusive') {
            return { index: 5, name: 'statistical_significance', threshold: 'paired bootstrap CI excludes zero', observed: `inconclusive: ${pair.reason}`, severity: 'inconclusive' };
        }

        const candidateWins = (pair.versionA === versionId && pair.winner === 'A') || (pair.versionB === versionId && pair.winner === 'B');

        if (!candidateWins) {
            return { index: 5, name: 'statistical_significance', threshold: `winner=candidate (id=${versionId})`, observed: `winner=${pair.winner}, CI=[${pair.ci95Low}, ${pair.ci95High}]`, severity: 'inconclusive' };
        }

        return null;
    }

    // --- Criterion 6: sample-sufficiency gates. ------------------------------
    //
    // Read trade totals off the bootstrap pair's countersByGate when available (the
    // bootstrap already encodes the canonical OPEN counts per candidate). The
    // bootstrap intentionally does NOT compute regime-bucketed counts or shadow-days
    // — it operates on the difference series, not per-event regime metadata — so any
    // zero from those two counters falls through to a tape-derived count keyed on
    // the candidate's direction → REGIME_TARGETS_BY_DIRECTION map (R1-H1 fix).

    private checkSampleSufficiency(report: IComparisonReport, candidate: StrategyVersionEntity): IPromotionCriterionFailure | null {
        const counters = pickSampleCounters(report, candidate);

        if (counters.trades < MIN_TOTAL_TRADES) {
            return { index: 6, name: 'sample_sufficiency', threshold: `trades >= ${MIN_TOTAL_TRADES}`, observed: `trades=${counters.trades}`, severity: 'inconclusive' };
        }

        if (counters.regimeTrades < MIN_REGIME_TRADES) {
            return { index: 6, name: 'sample_sufficiency', threshold: `regime trades >= ${MIN_REGIME_TRADES}`, observed: `regime trades=${counters.regimeTrades}`, severity: 'inconclusive' };
        }

        if (counters.shadowDays < MIN_SHADOW_DAYS) {
            return { index: 6, name: 'sample_sufficiency', threshold: `shadow days >= ${MIN_SHADOW_DAYS}`, observed: `shadow days=${counters.shadowDays}`, severity: 'inconclusive' };
        }

        return null;
    }

    // --- Criteria 7 & 9: deferred robustness. --------------------------------
    //
    // Deferred to W6.1 — robustness re-runs (ADR 0019 §2.4, criteria 7 + 9).
    // W6.1 will re-run BacktestRunnerService with stress configs
    // (BACKTEST_STRESS_SLIPPAGE_MULTIPLIER for criterion 7, stress-window date
    // sets for criterion 9) and emit a real verdict. Until then severity is
    // 'deferred' and the gate refuses to issue 'promote' on its own.

    private checkDeferredRobustness(kind: string): IPromotionCriterionFailure {
        return { index: -1, name: kind, threshold: 'criteria 1+2 still hold under stress', observed: 'deferred to M8 W6.1', severity: 'deferred' };
    }

    // --- Criterion 8: drop-best-5% robustness on OOS trades. -----------------
    //
    // Trim the top DROP_BEST_TRIM_PCT of OOS trades by netPnlUsdt and recompute
    // expectancy (sum netPnl) + profit factor on the remaining trades. Both must
    // still satisfy criteria 1 (>0) and 2 (>= MIN_PROFIT_FACTOR).

    private checkDropBestRobustness(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const oosTrades = collectOosTrades(report, versionId);

        if (oosTrades.length === 0) {
            return { index: 8, name: 'robustness_drop_best', threshold: 'criteria 1+2 hold after drop-best-5%', observed: 'no OOS trades', severity: 'block' };
        }

        const sorted = [...oosTrades].sort((left, right) => new Money(right.netPnlUsdt).minus(left.netPnlUsdt).toNumber());
        const trimCount = Math.floor(sorted.length * DROP_BEST_TRIM_PCT);
        const remaining = sorted.slice(trimCount);

        if (remaining.length === 0) {
            return { index: 8, name: 'robustness_drop_best', threshold: 'criteria 1+2 hold after drop-best-5%', observed: `trim removed all trades (n=${sorted.length})`, severity: 'block' };
        }

        let sumPnl = new Money(0);
        let grossWin = new Money(0);
        let grossLoss = new Money(0);

        for (const trade of remaining) {
            const pnl = new Money(trade.netPnlUsdt);
            sumPnl = sumPnl.plus(pnl);

            if (pnl.greaterThan(0)) {
                grossWin = grossWin.plus(pnl);
            } else {
                grossLoss = grossLoss.plus(pnl.abs());
            }
        }

        if (!sumPnl.greaterThan(0)) {
            return { index: 8, name: 'robustness_drop_best', threshold: 'criterion 1 (expectancy>0) after drop-best-5%', observed: `sumPnl=${sumPnl.toFixed()}`, severity: 'block' };
        }

        if (grossLoss.isZero()) {
            return null; // no losses → unbounded profit factor, passes by definition
        }

        const pf = grossWin.dividedBy(grossLoss);

        if (pf.lessThan(MIN_PROFIT_FACTOR)) {
            return { index: 8, name: 'robustness_drop_best', threshold: `criterion 2 (pf>=${MIN_PROFIT_FACTOR}) after drop-best-5%`, observed: `pf=${pf.toFixed()}`, severity: 'block' };
        }

        return null;
    }

    // --- Criterion 10: concentration limits. ---------------------------------

    private checkConcentration(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const trades = collectOosTrades(report, versionId);

        if (trades.length === 0) {
            return null;
        }

        const bySymbol = new Map<string, number>();
        const byWeek = new Map<string, number>();

        for (const trade of trades) {
            bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + 1);
            const week = isoWeekKey(trade.openedAtMs);
            byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
        }

        const totalTrades = trades.length;
        const symbolFailure = findConcentrationFailure(bySymbol, totalTrades, MAX_SYMBOL_CONCENTRATION_PCT, 'symbol');

        if (symbolFailure !== null) {
            return { index: 10, name: 'concentration', threshold: `no symbol > ${MAX_SYMBOL_CONCENTRATION_PCT}%`, observed: symbolFailure, severity: 'block' };
        }

        const weekFailure = findConcentrationFailure(byWeek, totalTrades, MAX_WEEK_CONCENTRATION_PCT, 'week');

        if (weekFailure !== null) {
            return { index: 10, name: 'concentration', threshold: `no week > ${MAX_WEEK_CONCENTRATION_PCT}%`, observed: weekFailure, severity: 'block' };
        }

        return null;
    }

    // --- Criterion 11: regime targeting. -------------------------------------

    private checkRegimeTargeting(report: IComparisonReport, candidate: StrategyVersionEntity, baseline: StrategyVersionEntity | null): IPromotionCriterionFailure | null {
        const targetRegimes = REGIME_TARGETS_BY_DIRECTION[candidate.direction as StrategyDirectionEnum];

        if (targetRegimes === undefined || targetRegimes.length === 0) {
            return { index: 11, name: 'regime_targeting', threshold: 'direction has a regime-target map', observed: `direction=${candidate.direction}`, severity: 'block' };
        }

        if (baseline === null) {
            // No baseline — same logic as criterion 5: we cannot demonstrate the
            // candidate beats anything in its target regimes.
            return { index: 11, name: 'regime_targeting', threshold: 'beats active baseline on target regimes', observed: 'no active baseline', severity: 'block' };
        }

        const breakdown = report.regimeBreakdown;

        if (breakdown === null) {
            return { index: 11, name: 'regime_targeting', threshold: 'beats active baseline on target regimes', observed: 'regime breakdown missing on report', severity: 'block' };
        }

        const candidateMetrics = breakdown.get(candidate.id);
        const baselineMetrics = breakdown.get(baseline.id);

        if (candidateMetrics === undefined || baselineMetrics === undefined) {
            return { index: 11, name: 'regime_targeting', threshold: 'beats active baseline on target regimes', observed: 'regime metrics missing for candidate or baseline', severity: 'block' };
        }

        for (const regime of targetRegimes) {
            const candidateBucket = candidateMetrics.buckets.get(regime);
            const baselineBucket = baselineMetrics.buckets.get(regime);
            const candidateMean = candidateBucket?.meanR ?? 0;
            const baselineMean = baselineBucket?.meanR ?? 0;

            if (candidateMean <= baselineMean) {
                return {
                    index: 11,
                    name: 'regime_targeting',
                    threshold: `meanR(candidate) > meanR(baseline) on regime=${regime}`,
                    // R2-M4: prepend `regime=<label>` to the observed string so
                    // an operator reading a failed outcome can tell which regime
                    // bucket the comparison failed on without re-running the gate.
                    observed: `regime=${regime} candidate=${candidateMean.toFixed(4)} baseline=${baselineMean.toFixed(4)}`,
                    severity: 'block',
                };
            }
        }

        return null;
    }

    // --- Criterion 12: low-fidelity dependence. ------------------------------
    //
    // Drop all trades flagged `lowFidelity=true` and re-evaluate criteria 1+2.

    private checkLowFidelityDependence(report: IComparisonReport, versionId: number): IPromotionCriterionFailure | null {
        const trades = collectOosTrades(report, versionId);
        const highFidelity = trades.filter((trade) => trade.lowFidelity !== true);

        if (highFidelity.length === 0 && trades.length > 0) {
            return { index: 12, name: 'low_fidelity_dependence', threshold: 'criteria 1+2 hold with lowFidelity trades excluded', observed: 'all OOS trades are lowFidelity', severity: 'block' };
        }

        let sumPnl = new Money(0);
        let grossWin = new Money(0);
        let grossLoss = new Money(0);

        for (const trade of highFidelity) {
            const pnl = new Money(trade.netPnlUsdt);
            sumPnl = sumPnl.plus(pnl);

            if (pnl.greaterThan(0)) {
                grossWin = grossWin.plus(pnl);
            } else {
                grossLoss = grossLoss.plus(pnl.abs());
            }
        }

        if (!sumPnl.greaterThan(0)) {
            return { index: 12, name: 'low_fidelity_dependence', threshold: 'expectancy>0 excluding lowFidelity', observed: `sumPnl=${sumPnl.toFixed()}`, severity: 'block' };
        }

        if (grossLoss.isZero()) {
            return null;
        }

        const pf = grossWin.dividedBy(grossLoss);

        if (pf.lessThan(MIN_PROFIT_FACTOR)) {
            return { index: 12, name: 'low_fidelity_dependence', threshold: `pf >= ${MIN_PROFIT_FACTOR} excluding lowFidelity`, observed: `pf=${pf.toFixed()}`, severity: 'block' };
        }

        return null;
    }
}

// --- Free helpers (no service state). ----------------------------------------

interface IOosCell {
    readonly foldIndex: number;
    readonly report: IBacktestReport;
}

function collectOosReports(report: IComparisonReport, versionId: number): IOosCell[] {
    const result: IOosCell[] = [];

    for (const [key, leaf] of report.perFoldReports.entries()) {
        const parsed = parseFoldCellKey(key);

        if (parsed === null) {
            continue;
        }

        if (parsed.versionId !== versionId || parsed.window !== 'oos') {
            continue;
        }

        result.push({ foldIndex: parsed.foldIndex, report: leaf });
    }

    return result;
}

function collectOosTrades(report: IComparisonReport, versionId: number): IBacktestTradeResult[] {
    const cells = collectOosReports(report, versionId);
    const trades: IBacktestTradeResult[] = [];

    for (const cell of cells) {
        for (const trade of cell.report.trades) {
            trades.push(trade);
        }
    }

    return trades;
}

function parseFoldCellKey(key: ComparisonFoldCellKey | string): { versionId: number; foldIndex: number; window: 'train' | 'validation' | 'oos' } | null {
    const parts = String(key).split(':');

    if (parts.length !== 3) {
        return null;
    }

    const versionId = Number(parts[0]);
    const foldIndex = Number(parts[1]);
    const window = parts[2];

    if (!Number.isFinite(versionId) || !Number.isFinite(foldIndex) || (window !== 'train' && window !== 'validation' && window !== 'oos')) {
        return null;
    }

    return { versionId, foldIndex, window };
}

function parseProfitFactor(raw: string): number {
    if (raw === 'Infinity') {
        return Number.POSITIVE_INFINITY;
    }

    const value = Number(raw);

    return Number.isFinite(value) ? value : 0;
}

function findPairwiseResult(stats: readonly IPairwiseBootstrapResult[] | null, versionId: number, baselineId: number): IPairwiseBootstrapResult | null {
    if (stats === null) {
        return null;
    }

    for (const pair of stats) {
        const matches = (pair.versionA === versionId && pair.versionB === baselineId) || (pair.versionA === baselineId && pair.versionB === versionId);

        if (matches) {
            return pair;
        }
    }

    return null;
}

interface ISampleCounters {
    readonly trades: number;
    readonly regimeTrades: number;
    readonly shadowDays: number;
}

function pickSampleCounters(report: IComparisonReport, candidate: StrategyVersionEntity): ISampleCounters {
    // R1-H1 fix: BootstrapStatsService.computeOnePair returns 0 for regimeTradesA/B
    // and shadowDays by design — those counters are not derivable from the difference
    // series. When bootstrap supplies zeros (the current production path), fall
    // through to a tape-derived count filtered by REGIME_TARGETS_BY_DIRECTION; when
    // a future bootstrap variant supplies non-zero counters, prefer those.
    let trades: number | null = null;
    let regimeTrades: number | null = null;
    let shadowDays: number | null = null;

    if (report.pairwiseStats !== null) {
        for (const pair of report.pairwiseStats) {
            const aIs = pair.versionA === candidate.id;
            const bIs = pair.versionB === candidate.id;

            if (!aIs && !bIs) {
                continue;
            }

            const c = pair.countersByGate;
            trades = aIs ? c.tradesA : c.tradesB;
            const pairRegimeTrades = aIs ? c.regimeTradesA : c.regimeTradesB;
            regimeTrades = pairRegimeTrades > 0 ? pairRegimeTrades : null;
            shadowDays = c.shadowDays > 0 ? c.shadowDays : null;
            break;
        }
    }

    const needsTapeDerivedRegime = regimeTrades === null;
    const needsTapeDerivedShadow = shadowDays === null;
    const oosTrades = trades === null || needsTapeDerivedRegime || needsTapeDerivedShadow ? collectOosTrades(report, candidate.id) : [];

    if (trades === null) {
        trades = oosTrades.length;
    }

    if (regimeTrades === null) {
        const targetRegimes = REGIME_TARGETS_BY_DIRECTION[candidate.direction as StrategyDirectionEnum];
        regimeTrades = countTradesInTargetRegimes(oosTrades, targetRegimes);
    }

    if (shadowDays === null) {
        shadowDays = countDistinctTradingDays(oosTrades);
    }

    return { trades, regimeTrades, shadowDays };
}

function countTradesInTargetRegimes(trades: readonly IBacktestTradeResult[], targetRegimes: readonly RegimeLabelEnum[] | undefined): number {
    if (targetRegimes === undefined || targetRegimes.length === 0) {
        return trades.length;
    }

    const targetSet = new Set<string>(targetRegimes);
    let count = 0;

    for (const trade of trades) {
        if (targetSet.has(trade.regimeAtEntry)) {
            count += 1;
        }
    }

    return count;
}

function countDistinctTradingDays(trades: readonly IBacktestTradeResult[]): number {
    const distinct = new Set<string>();

    for (const trade of trades) {
        distinct.add(new Date(trade.openedAtMs).toISOString().slice(0, 10));
    }

    return distinct.size;
}

function findConcentrationFailure(buckets: ReadonlyMap<string, number>, total: number, limitPct: number, dimension: string): string | null {
    for (const [key, count] of buckets.entries()) {
        const pct = (count / total) * 100;

        if (pct > limitPct) {
            return `${dimension}=${key}: ${pct.toFixed(2)}% of trades (${count}/${total})`;
        }
    }

    return null;
}

// ISO-8601 week key (YYYY-Www) — a calendar-week bucket for concentration. Pure
// function of `ms` so the gate stays deterministic.
function isoWeekKey(ms: number): string {
    const date = new Date(ms);
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNumber = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNumber + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstThursdayDayNumber = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNumber + 3);
    const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / MS_PER_WEEK);

    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}


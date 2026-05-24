import { ExitReasonEnum, IBacktestConfig, IBacktestReport, IBacktestTradeResult, RegimeLabelEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

import { Money } from '../../common/utils/money';
import { StrategyVersionEntity } from '../../strategy/entity/StrategyVersionEntity';
import {
    ComparisonFoldCellKey,
    IComparisonEventOutcome,
    IComparisonReport,
    IComparisonVersionRef,
    IPerVersionOutcomeRecord,
    IRegimeMetrics,
    ITailRiskStats,
    ITapedEvent,
    IWalkForwardFold,
    IWalkForwardSplitPolicy,
} from '../interface';
import { computeRegimeBreakdown, computeTailRiskStats, IRegimePerEventR } from '../stats/perVersionStats';
import { BacktestRunnerService } from './BacktestRunnerService';
import { BootstrapStatsService } from './BootstrapStatsService';
import { WalkForwardPlanner } from './WalkForwardPlanner';

// Driver inputs (ADR 0017 §2). One comparison run replays a candidate set across all
// walk-forward folds and aggregates per-event outcomes from each version.
export interface IComparisonRunRequest {
    readonly runId: string;
    readonly rangeFromMs: number;
    readonly rangeToMs: number;
    readonly splitPolicy: IWalkForwardSplitPolicy;
    readonly candidates: readonly StrategyVersionEntity[];
    // Operator-supplied label threaded into every nested `IBacktestConfig.runLabel`. The
    // per-cell label is `${runLabel}:v${versionId}:f${foldIndex}:${window}` so disk
    // artefacts and the per-cell M7 reports remain traceable to the comparison row.
    readonly runLabel: string;
    readonly allocatedCapitalUsdt: string;
    readonly latencyMs: number;
    readonly enableDepthAwareSlippage: boolean;
    readonly enableIntrabarStopSimulation: boolean;
}

// The comparison driver (ADR 0017 §2.2). Not a new engine — `BacktestRunnerService`
// remains the leaf execution path. This service composes that path twice:
//   1. Once over the full range in "record" mode to build a version-agnostic event tape.
//   2. Once per `(version, fold, window)` cell in "replay-tape" mode, slicing the tape
//      to the fold window so every candidate evaluates the same event set under the
//      same market path.
// W5 / W6 fields on the returned `IComparisonReport` are left as `unknown` placeholders;
// the bootstrap stats / regime breakdown / promotion gate waves populate them in place.
@Injectable()
export class ComparisonRunnerService {
    private readonly logger = new Logger(ComparisonRunnerService.name);

    constructor(
        private readonly backtestRunner: BacktestRunnerService,
        private readonly bootstrapStats: BootstrapStatsService,
    ) {}

    async runComparison(request: IComparisonRunRequest): Promise<IComparisonReport> {
        this.assertValidRequest(request);

        const folds = WalkForwardPlanner.plan(request.rangeFromMs, request.rangeToMs, request.splitPolicy);

        if (folds.length === 0) {
            throw new Error(`ComparisonRunnerService: walk-forward planner returned zero folds for range [${request.rangeFromMs}, ${request.rangeToMs}); range is too short for policy`);
        }

        const tape = await this.recordRangeTape(request);

        this.logger.log(`comparison run=${request.runId} folds=${folds.length} versions=${request.candidates.length} tapeSize=${tape.length}`);

        const perFoldReports: Map<ComparisonFoldCellKey, IBacktestReport> = new Map();
        const eventOutcomes = this.buildOutcomesIndex(tape);

        for (const candidate of request.candidates) {
            for (const fold of folds) {
                await this.replayFoldWindow(request, candidate, fold, 'train', tape, perFoldReports, eventOutcomes);
                await this.replayFoldWindow(request, candidate, fold, 'validation', tape, perFoldReports, eventOutcomes);
                await this.replayFoldWindow(request, candidate, fold, 'oos', tape, perFoldReports, eventOutcomes);
            }
        }

        return this.assembleReport(request, folds, perFoldReports, eventOutcomes);
    }

    private async recordRangeTape(request: IComparisonRunRequest): Promise<readonly ITapedEvent[]> {
        // The tape-recording pass is version-agnostic. We use the first candidate purely
        // to satisfy the runner's strategyVersionId requirement (trigger thresholds come
        // from its params); the tape captures every fired event regardless. A future
        // refinement could expose an explicit tape-params input on the request — for now
        // pin to the first candidate to keep the W4 surface narrow.
        if (request.candidates.length === 0) {
            throw new Error('ComparisonRunnerService: at least one candidate version required');
        }

        const tapeConfig = this.buildConfig(request, request.candidates[0].id, `${request.runLabel}:tape`, request.rangeFromMs, request.rangeToMs);

        return this.backtestRunner.recordEventTape(tapeConfig);
    }

    // Slice the tape to a fold window and dispatch a replay-tape pass for the given
    // candidate. The fold window's `[fromMs, toMs)` becomes the IBacktestConfig date range;
    // the runner walks bars in that window only, and only those tape entries whose
    // `triggerTs` lands inside it dispatch to the strategy. Outcomes from this cell's
    // trade list are zipped back into the per-event outcome index.
    private async replayFoldWindow(
        request: IComparisonRunRequest,
        candidate: StrategyVersionEntity,
        fold: IWalkForwardFold,
        window: 'train' | 'validation' | 'oos',
        tape: readonly ITapedEvent[],
        perFoldReports: Map<ComparisonFoldCellKey, IBacktestReport>,
        eventOutcomes: Map<string, IComparisonEventOutcome>,
    ): Promise<void> {
        const { fromMs, toMs } = resolveWindowBounds(fold, window);
        const sliced = tape.filter((entry) => entry.triggerTs >= fromMs && entry.triggerTs < toMs);
        const config = this.buildConfig(request, candidate.id, `${request.runLabel}:v${candidate.id}:f${fold.foldIndex}:${window}`, fromMs, toMs);

        const report = await this.backtestRunner.replayTape(config, sliced);

        const key: ComparisonFoldCellKey = `${candidate.id}:${fold.foldIndex}:${window}`;
        perFoldReports.set(key, report);

        this.applyOutcomesFromReport(candidate.id, sliced, report, eventOutcomes);
    }

    // Build (or refresh) the per-event outcome rows for one (version, fold-window) cell.
    // Every tape entry in the slice gets an entry in `outcomesByVersion` for this version:
    //   - If the M7 trade list carries an entry with the same `eventId` → 'open' record
    //     with the net PnL, hold ms, exit reason, rPerUnitRisk, and lowFidelity flag.
    //   - Otherwise the version either skipped or missed the limit. The boundary into
    //     'skip' vs 'missed' isn't directly recoverable from `IBacktestReport.trades`
    //     (only counts are surfaced); ADR 0017 §2.3 defines 'skip' as the meaningful
    //     fallback for analytics, so we record 'skip' and rely on aggregate
    //     `missedLimitFillCount` for missed-rate metrics. (W5 may refine this once the
    //     M7 report surfaces a per-event skip/missed discriminator.)
    private applyOutcomesFromReport(
        versionId: number,
        sliced: readonly ITapedEvent[],
        report: IBacktestReport,
        eventOutcomes: Map<string, IComparisonEventOutcome>,
    ): void {
        const tradesByEventId: Map<string, IBacktestTradeResult> = new Map();

        for (const trade of report.trades) {
            tradesByEventId.set(trade.eventId, trade);
        }

        for (const taped of sliced) {
            const outcome = eventOutcomes.get(taped.eventId);

            if (outcome === undefined) {
                continue;
            }

            const trade = tradesByEventId.get(taped.eventId) ?? null;
            outcome.outcomesByVersion.set(versionId, buildOutcomeRecord(trade));
        }
    }

    // Pre-seed an outcome row for every tape entry so the assembler returns one row per
    // event regardless of how many versions opened on it. `outcomesByVersion` is populated
    // incrementally by each `replayFoldWindow` call. An event that lands inside a fold
    // window for one version and outside for another (rare — happens only at fold edges
    // when windows differ across versions, which they don't in M8) will have fewer keys;
    // in M8 every version evaluates the same folds so every map has exactly N keys.
    private buildOutcomesIndex(tape: readonly ITapedEvent[]): Map<string, IComparisonEventOutcome> {
        const result: Map<string, IComparisonEventOutcome> = new Map();

        for (const taped of tape) {
            result.set(taped.eventId, {
                eventId: taped.eventId,
                symbol: taped.symbol,
                triggerTs: taped.triggerTs,
                regime: taped.regime,
                flowType: taped.flowType,
                outcomesByVersion: new Map(),
            });
        }

        return result;
    }

    private assembleReport(
        request: IComparisonRunRequest,
        folds: readonly IWalkForwardFold[],
        perFoldReports: Map<ComparisonFoldCellKey, IBacktestReport>,
        eventOutcomes: Map<string, IComparisonEventOutcome>,
    ): IComparisonReport {
        const versions: IComparisonVersionRef[] = request.candidates.map((candidate) => ({
            versionId: candidate.id,
            name: candidate.name,
            version: candidate.version,
            direction: candidate.direction,
            paramsHash: hashParams(candidate.params),
        }));

        // Outcomes are emitted in tape (chronological) order so the bootstrap stats can
        // assume a stable iteration order without re-sorting — the paired difference
        // series must respect the underlying autocorrelation structure.
        const orderedOutcomes: IComparisonEventOutcome[] = Array.from(eventOutcomes.values());
        const lowFidelityTradeCount = sumLowFidelity(perFoldReports);

        // W5b: bootstrap + per-version regime breakdown + tail-risk stats (ADR 0018).
        const versionIds = versions.map((v) => v.versionId);
        const pairwiseStats = this.bootstrapStats.computePairwiseStats(orderedOutcomes, versionIds, request.runLabel);
        const regimeBreakdown = buildRegimeBreakdownByVersion(orderedOutcomes, versionIds);
        const tailRiskByVersion = buildTailRiskByVersion(orderedOutcomes, versionIds);
        const multipleComparisonNote = this.bootstrapStats.buildMultipleComparisonNote(versionIds);

        return {
            runId: request.runId,
            rangeFromMs: request.rangeFromMs,
            rangeToMs: request.rangeToMs,
            splitPolicy: request.splitPolicy,
            folds,
            versions,
            perFoldReports,
            eventOutcomes: orderedOutcomes,
            pairwiseStats,
            regimeBreakdown,
            tailRiskByVersion,
            multipleComparisonNote,
            // W6 placeholder. Populated by the promotion-gate wave.
            promotionDecisions: null,
            lowFidelityTradeCount,
        };
    }

    // Compose an `IBacktestConfig` for a specific cell. Date strings are derived from the
    // ms bounds because the runner's date-parsing entry point is `IBacktestConfig.from/to`.
    // The runner's planner snaps `toMs` to midnight (`+ 1 day` open), so we use exclusive-
    // upper convention via the existing helper (one millisecond before the next day boundary
    // would mis-quantize a fold window into the prior day; the runner itself walks bars
    // strictly inside `[fromMs, toMs)` so dropping to date strings is acceptable for M8 —
    // a future refinement may switch the runner to ms-bound config for sub-day folds).
    private buildConfig(
        request: IComparisonRunRequest,
        strategyVersionId: number,
        runLabel: string,
        fromMs: number,
        toMs: number,
    ): IBacktestConfig {
        return {
            strategyVersionId,
            fromUtcDate: msToUtcDate(fromMs),
            toUtcDate: msToUtcDate(toMs),
            allocatedCapitalUsdt: request.allocatedCapitalUsdt,
            latencyMs: request.latencyMs,
            enableDepthAwareSlippage: request.enableDepthAwareSlippage,
            enableIntrabarStopSimulation: request.enableIntrabarStopSimulation,
            runLabel,
        };
    }

    private assertValidRequest(request: IComparisonRunRequest): void {
        if (request.rangeToMs <= request.rangeFromMs) {
            throw new Error(`ComparisonRunnerService: rangeToMs must be after rangeFromMs (${request.rangeFromMs} >= ${request.rangeToMs})`);
        }

        if (request.candidates.length === 0) {
            throw new Error('ComparisonRunnerService: at least one candidate version required');
        }
    }
}

// Resolve a fold's `(fromMs, toMs)` for a named window. Mirrors ADR 0017 §2.1's
// `IWalkForwardFold` field naming. Kept as a free function so unit tests can exercise it
// without instantiating the Nest service.
function resolveWindowBounds(fold: IWalkForwardFold, window: 'train' | 'validation' | 'oos'): { fromMs: number; toMs: number } {
    if (window === 'train') {
        return { fromMs: fold.trainFromMs, toMs: fold.trainToMs };
    }

    if (window === 'validation') {
        return { fromMs: fold.validationFromMs, toMs: fold.validationToMs };
    }

    return { fromMs: fold.oosFromMs, toMs: fold.oosToMs };
}

// Per-version outcome record builder. When the M7 trade list contains a row for the event,
// translate it into an 'open' record (with PnL, hold time, exit reason, etc.); otherwise
// emit a 'skip' record per ADR 0017 §2.3 fallback semantics.
//
// `rPerUnitRisk` for an opened trade is `netPnl / riskBudgetSpent` (ADR 0018 §2.1). W5b:
// `IBacktestTradeResult.riskBudgetSpent` carries the gate's ATR-sized risk budget as a
// decimal-as-string. A zero risk budget (degenerate stop = entry) collapses the ratio to
// zero — the gate refuses such intents in production, but the guard keeps the math defined.
function buildOutcomeRecord(trade: IBacktestTradeResult | null): IPerVersionOutcomeRecord {
    if (trade === null) {
        return { action: 'skip', rPerUnitRisk: 0 };
    }

    const netPnl = new Money(trade.netPnlUsdt);
    const riskBudget = new Money(trade.riskBudgetSpent);
    const rPerUnitRisk = riskBudget.isZero() ? 0 : netPnl.dividedBy(riskBudget).toNumber();

    return {
        action: 'open',
        netPnl,
        holdMs: trade.holdMs,
        rPerUnitRisk,
        exitReason: trade.exitReason as ExitReasonEnum,
        lowFidelity: trade.lowFidelity,
    };
}

// Build the per-version regime breakdown map (ADR 0017 §2.4). For each version, walk the
// chronological event tape collecting `(regime, r)` rows for every event the version saw,
// then fold through `computeRegimeBreakdown` to bucket and aggregate. Skips/missed events
// contribute `r = 0` and count toward `tradeCount` but never as wins — matches the W5a
// contract.
function buildRegimeBreakdownByVersion(
    eventOutcomes: readonly IComparisonEventOutcome[],
    versionIds: readonly number[],
): Map<number, IRegimeMetrics> {
    const result: Map<number, IRegimeMetrics> = new Map();

    for (const versionId of versionIds) {
        const perEventR: IRegimePerEventR[] = [];

        for (const event of eventOutcomes) {
            const record = event.outcomesByVersion.get(versionId);
            perEventR.push({
                regime: event.regime as RegimeLabelEnum,
                r: record?.rPerUnitRisk ?? 0,
            });
        }

        result.set(versionId, computeRegimeBreakdown(perEventR));
    }

    return result;
}

// Build the per-version tail-risk stats map (ADR 0018 §2.6). Tail stats are computed on
// the full per-event `r` series for the version (including skips at r=0) so the streak /
// expected-shortfall numbers match what a risk reviewer reads off the same event tape.
// A version with zero events in the tape is skipped — `computeTailRiskStats` throws on
// an empty series by contract, so the map entry is omitted rather than synthesised.
function buildTailRiskByVersion(
    eventOutcomes: readonly IComparisonEventOutcome[],
    versionIds: readonly number[],
): Map<number, ITailRiskStats> {
    const result: Map<number, ITailRiskStats> = new Map();

    if (eventOutcomes.length === 0) {
        return result;
    }

    for (const versionId of versionIds) {
        const rSeries: number[] = new Array(eventOutcomes.length);

        for (let i = 0; i < eventOutcomes.length; i += 1) {
            const record = eventOutcomes[i].outcomesByVersion.get(versionId);
            rSeries[i] = record?.rPerUnitRisk ?? 0;
        }

        result.set(versionId, computeTailRiskStats(rSeries));
    }

    return result;
}

function sumLowFidelity(perFoldReports: Map<ComparisonFoldCellKey, IBacktestReport>): number {
    let total = 0;

    for (const report of perFoldReports.values()) {
        total += report.lowFidelityTradeCount;
    }

    return total;
}

// Stable hash of the params blob so the W6 promotion gate / W7 CLI can detect param
// drift across runs without diffing the full JSON. SHA-256 truncated to 16 hex chars is
// collision-safe at M8 cadence (hundreds of distinct param sets across the project's
// lifetime, not billions).
function hashParams(params: Record<string, unknown>): string {
    const stable = stableStringify(params);

    return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);

    return `{${entries.join(',')}}`;
}

function msToUtcDate(ms: number): string {
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

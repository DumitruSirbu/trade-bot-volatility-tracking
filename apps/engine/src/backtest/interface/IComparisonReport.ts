import { IBacktestReport, StrategyDirectionEnum } from '@bot/shared';

import { IComparisonEventOutcome } from './IComparisonEventOutcome';
import { IPairwiseBootstrapResult } from './IPairwiseBootstrapResult';
import { IRegimeMetrics } from './IRegimeMetrics';
import { ITailRiskStats } from './ITailRiskStats';
import { IWalkForwardFold } from './IWalkForwardFold';
import { IWalkForwardSplitPolicy } from './IWalkForwardSplitPolicy';

// One row in `IComparisonReport.versions` — the candidate identity stripped from the
// `StrategyVersionEntity`. Kept narrow so the artefact JSON does not embed the full ORM
// shape (params blob, lineage pointers, audit timestamps) for every version.
export interface IComparisonVersionRef {
    readonly versionId: number;
    readonly name: string;
    readonly version: number;
    readonly direction: StrategyDirectionEnum;
    readonly paramsHash: string;
}

// `perFoldReports` cell key. Stringified `${versionId}:${foldIndex}:${window}` so the
// shape survives JSON round-trip into `comparison_reports.artefact_uri` (a Map<tuple,_>
// would be lost). Inverse helpers live next to the W4 driver.
export type ComparisonFoldCellKey = `${number}:${number}:${'train' | 'validation' | 'oos'}`;

// The W4 output of a comparison run (ADR 0017 §2.4). Composes M7's `IBacktestReport` as a
// leaf — one report per `(versionId, foldIndex, window)` cell — and threads the per-event
// outcome aggregator across them.
//
// W5/W6 placeholder fields (`pairwiseStats`, `regimeBreakdown`, `promotionDecisions`) are
// typed as `unknown` here. Each is filled by its own wave:
//   - W5 bootstrap stats → ADR 0018, `IPairwiseBootstrapResult[]`
//   - W5 regime breakdown → ADR 0017 §2.4, `Map<(versionId, regime), IRegimeMetrics>`
//   - W6 promotion gate → ADR 0019, `Map<versionId, IPromotionGateOutcome>`
// Leaving them `unknown` keeps W4 boundary-stable: a subsequent wave can refine the type
// without rewriting any field W4 already populates.
export interface IComparisonReport {
    readonly runId: string;
    readonly rangeFromMs: number;
    readonly rangeToMs: number;
    readonly splitPolicy: IWalkForwardSplitPolicy;
    readonly folds: readonly IWalkForwardFold[];
    readonly versions: readonly IComparisonVersionRef[];
    readonly perFoldReports: Map<ComparisonFoldCellKey, IBacktestReport>;
    readonly eventOutcomes: readonly IComparisonEventOutcome[];
    // W5b — bootstrap pairwise comparison stats (ADR 0018). Null until populated by
    // ComparisonRunnerService via BootstrapStatsService.computePairwiseStats.
    readonly pairwiseStats: readonly IPairwiseBootstrapResult[] | null;
    // W5b — per-version regime breakdown (ADR 0017 §2.4). Keyed by `versionId`; each
    // entry's `buckets` map keys by `RegimeLabelEnum` (see IRegimeMetrics). Null until
    // populated.
    readonly regimeBreakdown: ReadonlyMap<number, IRegimeMetrics> | null;
    // W5b — per-version tail-risk stats (ADR 0018 §2.6). Keyed by `versionId`. Reported
    // alongside the bootstrap so the promotion gate (W6) can reject candidates with a
    // brutal max single loss / fat-tail kurtosis even if mean expectancy wins. Null until
    // populated.
    readonly tailRiskByVersion: ReadonlyMap<number, ITailRiskStats> | null;
    // W5b — flagged whenever the candidate set has more than one pair (ADR 0018 §2.7).
    // The promotion gate combines this with the per-regime breakdown to decide whether
    // a single marginal-pair win should be treated as inconclusive. Null when only one
    // pair exists (no family-wise risk).
    readonly multipleComparisonNote: string | null;
    // W6 placeholder — promotion-gate decision per version (ADR 0019). Populated as
    // `Map<number, IPromotionGateOutcome>` keyed by `versionId`.
    readonly promotionDecisions: unknown;
    readonly lowFidelityTradeCount: number;
}

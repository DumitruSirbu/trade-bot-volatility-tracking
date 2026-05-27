import type { IPerformanceByVersionView } from './IPerformanceByVersionView.js';

export interface IPairedDiffSummary {
    /** Number of decision events where BOTH versions emitted a decision. */
    readonly pairedEventCount: number;
    /** Number of paired events where BOTH versions opened+closed a position. */
    readonly pairedTradedEventCount: number;
    /** Sum of (A.realized_pnl - B.realized_pnl) across paired traded events; decimal string. */
    readonly netPnlDeltaUsd: string;
    /** Mean of per-event (A.realized_pnl - B.realized_pnl) across paired traded events; decimal string or null when n=0 or below the sample-size floor. */
    readonly meanPnlDeltaUsd: string | null;
    /** True when `pairedTradedEventCount` < `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN`; mean is suppressed to prevent misleading single-sample readings. */
    readonly belowSampleFloor: boolean;
}

export interface IVersionComparisonResult {
    readonly aPerformance: IPerformanceByVersionView;
    readonly bPerformance: IPerformanceByVersionView;
    readonly pairedDiff: IPairedDiffSummary;
}

// M12 W1 — @bot/analysis barrel. Read-only analytical query layer.
//
// W2 will extend this with the extracted backtest runner.
//
// Boundary invariant (ADR 0033 §2.2 / §2.3): this package depends on
// @bot/shared only — never on @bot/engine and never via relative reach into
// apps/engine/*. Root eslint.config.js enforces this at lint time.

export { createMcpDataSource, buildMcpDataSourceOptions, McpDataSourceConfigError } from './db/DataSourceFactory.js';
export type { IMcpDataSourceEnv } from './db/DataSourceFactory.js';

export { AnalysisValidationError, validateDateRangeOrThrow } from './util/analysisValidation.js';
export { getPerformance } from './query/getPerformance.js';
export type { IGetPerformanceParams } from './query/getPerformance.js';

export { compareVersions } from './query/compareVersions.js';
export type { ICompareVersionsParams } from './query/compareVersions.js';
// Re-exports from @bot/shared for backward compatibility.
export type { IPairedDiffSummary, IVersionComparisonResult } from '@bot/shared';
export { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN } from '@bot/shared';

export { listPositions } from './query/listPositions.js';
export type { IListPositionsParams, PositionListStatusFilter } from './query/listPositions.js';

export { getDecisions } from './query/getDecisions.js';
export type { IGetDecisionsParams, IGetDecisionsResult } from './query/getDecisions.js';

export { getFunnelSummary } from './query/getFunnelSummary.js';
export type { IFunnelSummaryRow, GateAllowedBucket, SlSubCause } from './query/getFunnelSummary.js';

export { getIdiosyncraticEdgeReport } from './query/getIdiosyncraticEdgeReport.js';
export type { IIdiosyncraticEdgeReport, IIdiosyncraticEdgeReportParams, IRegimeBucket } from './query/getIdiosyncraticEdgeReport.js';

export { getIdiosyncrasyMissDistribution } from './query/getIdiosyncrasyMissDistribution.js';
export type {
    IIdiosyncrasyMissDistributionRow,
    IIdiosyncrasyMissDistributionParams,
    IMissDistributionBucket,
} from './query/getIdiosyncrasyMissDistribution.js';

export { getRetryAttribution } from './query/getRetryAttribution.js';
export type {
    IGetRetryAttributionParams,
    IRetryAttributionReport,
    IRetrySurvival,
    IRetryCounterfactual,
    IMatchedControlCell,
    IDriftDistributionBucket,
} from './query/getRetryAttribution.js';

export { selectHaltState } from './query/selectHaltState.js';

export { decodeCursor, encodeCursor } from './util/CursorCodec.js';
export type { ICursorPayload } from './util/CursorCodec.js';

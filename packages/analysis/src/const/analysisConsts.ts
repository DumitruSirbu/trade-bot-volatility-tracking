// M12 W6 fix wave 5 — analysis-layer numeric constants.
//
// Previously scattered as `const` declarations inline at the top of each
// query module. Clean-code reviewer flagged the duplication: same numbers
// (50, 200, 366, 10_000) cluster the codebase with semantic intent that is
// only obvious after reading three files. Centralising here also makes the
// "soft cap vs hard cap" policy (ADR 0034 §2.4) inspectable in one place.

/** Default page size when callers omit `limit` on paginated listings. */
export const DEFAULT_LIMIT = 50;

/** Hard upper bound on `limit` per paginated listing call. */
export const MAX_LIMIT = 200;

/** Milliseconds per UTC day; used for date-window arithmetic. */
export const MS_PER_DAY = 86_400_000;

/** Maximum allowable analysis date range, in milliseconds (~1 year). */
export const ANALYSIS_MAX_RANGE_MS = 366 * MS_PER_DAY;

/**
 * Hard cap on the number of decision rows returned by a single
 * `getDecisions` call (ADR 0034 §2.4). Anything wanting more than this
 * should paginate via `listPositions`-style cursors; we fail loudly rather
 * than silently truncate.
 */
export const DECISIONS_ROW_CAP = 10_000;

/**
 * `strategy_versions.status` value for the single live version whose realized
 * trades land in `positions`/`decisions`. Mirrors `StrategyStatusEnum.ACTIVE`
 * (`@bot/shared`) — duplicated as a local literal because the analysis ts-jest
 * config resolves `@bot/shared` to source artifacts that fail value-import under
 * the test runner (same reason `formatMoneyString` imports `decimal.js`
 * directly). The string MUST stay in sync with `StrategyStatusEnum.ACTIVE`.
 */
export const STRATEGY_STATUS_ACTIVE = 'active';

/**
 * Fallback surfaced on `IClosedPositionView.strategyVersionName` when a row's
 * `strategy_version_id` references a version deleted out-of-band. Mirrors
 * `UNKNOWN_STRATEGY_VERSION_NAME` in `apps/engine/src/read-api/const/readApiConsts.ts`
 * — duplicated rather than imported since the two packages don't share a
 * runtime-const boundary.
 */
export const UNKNOWN_STRATEGY_VERSION_NAME = 'unknown';

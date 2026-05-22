// tick_aggregates partitioning + retention policy (ADR 0002 §3). The table is RANGE
// partitioned by `ts` at daily granularity.

// Rolling retention window: partitions older than this are DROPped (whole-partition
// drop, never row-level DELETE). 90 days comfortably covers the M7 intraday backtest.
export const TICK_AGGREGATE_RETENTION_DAYS = 30;

// How many days ahead the create-ahead cron pre-creates partitions, so an insert never
// hits a missing partition even after a window of downtime (self-heals on next run).
export const TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS = 7;

// Parent table name and the per-partition naming prefix (partition = prefix + YYYYMMDD).
export const TICK_AGGREGATE_TABLE = 'tick_aggregates';
export const TICK_AGGREGATE_PARTITION_PREFIX = 'tick_aggregates_p';

// Fixed 1-second bucket size for sub-minute aggregation. Raw ms ticks are folded into
// fixed 1s OHLCV buckets (floor ts to the second) so a row is emitted ONCE per closed
// bucket — multiple ticks/sec no longer collide on UNIQUE(symbol, ts), and each bucket's
// open/high/low/close preserves the intra-second spike the M7 backtest must reconstruct.
export const TICK_AGGREGATE_BUCKET_MS = 5000;

// Daily cron times (server TZ) for the partition-management jobs. Create-ahead runs near
// midnight; retention drop runs shortly after so a freshly-created window is never the
// one being dropped.
export const TICK_AGGREGATE_CREATE_PARTITIONS_CRON = '5 0 * * *';
export const TICK_AGGREGATE_DROP_PARTITIONS_CRON = '35 0 * * *';

// Substring matched against driver error messages to detect a duplicate-key violation so
// the passive persistence listener can swallow it (idempotency, conventions Error rule).
export const DUPLICATE_KEY_ERROR_FRAGMENTS = ['duplicate key', 'unique constraint'];

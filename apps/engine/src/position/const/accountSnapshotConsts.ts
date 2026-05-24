import { Money, MoneyValue } from '../../common/utils/money';

// ADR 0012 §6 — `account_snapshots` writer cadence + tolerances. Moved out of
// `AccountSnapshotWriter.ts` per the conventions' "no top-of-file exported
// consts alongside services" rule (R1.3.3).

// Periodic write cadence. 60 seconds catches intra-bar equity moves for
// drawdown tracking, slow enough to keep the table from bloating
// (~525k rows/year at 60s; trivial).
export const ACCOUNT_SNAPSHOT_INTERVAL_MS = 60_000;

// USDT-M perp settlement currency. `fetchBalance()` returns a multi-asset
// array; the writer picks this entry.
export const SETTLE_CURRENCY = 'USDT';

// ADR 0012 §6 + plan W7 item 3 — "same-minute skip rule to avoid double-write".
// Uses UTC-minute bucketing (`floor(ms / 60_000)`) so a scheduler tick AND a
// drift-forced `writeNow()` within the same wall-minute coalesce to one row.
// Boot and explicit drift-forced calls bypass the skip.
export const SAME_MINUTE_BUCKET_MS = 60_000;

// ADR 0012 §6 — equity drift alert threshold. Used by W8 boot-time comparison:
// a discrepancy between the latest pre-crash snapshot and the boot snapshot
// equity beyond this tolerance raises an alert.
export const ACCOUNT_SNAPSHOT_DRIFT_TOLERANCE_USDT: MoneyValue = new Money('1');

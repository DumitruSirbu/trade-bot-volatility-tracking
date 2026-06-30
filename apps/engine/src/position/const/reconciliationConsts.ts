// ADR 0010 §2 — reconciliation cadence constants. Moved out of
// `ReconciliationService.ts` per the conventions' "no top-of-file exported
// consts alongside services" rule (R1.3.3).

import { Money, MoneyValue } from '../../common/utils/money';

// Periodic 30s tick — the production scheduler cadence. The W4a default.
export const RECONCILIATION_TICK_MS = 30_000;

// Lower bound between two ticks consulted by the public `tick()` entry point.
// `forceTick()` (boot / tests / operator) bypasses it. Protects against
// accidental rate-limit storms when the scheduler and a boot-time call land
// close together (ADR 0010 §2).
export const RECONCILIATION_MIN_INTERVAL_MS = 5_000;

// M6 R1.2.4 (ADR 0010 §1f) — case-(f) UNKNOWN_INTENT_OUTCOME backstop window.
// If the exchange query keeps returning non-terminal for longer than this
// window, the bot stops waiting and emits `UNRESOLVED_TTL` (operator alert).
// The reservation release is handled separately by
// `expireStaleReservations(nowMs)` at the top of `runPass` — see ADR-0010 §4.
// 5 minutes is the working default (long enough for normal exchange-side
// reconciliation lag; short enough that an actually-stuck intent surfaces
// within ~10 reconciliation ticks).
export const UNKNOWN_INTENT_TTL_MS = 5 * 60_000;

// M6 W4b (ADR 0010 §1a) — foreign-position adoption sentinel name + version.
// The sentinel `strategy_versions` row is created by the W1 migration; the
// reconciliation case-(a) handler attaches every adopted foreign position to
// it so the FK to `strategy_versions` is preserved without inventing per-event
// rows for operator-managed positions.
export const MANUAL_ADOPTED_STRATEGY_NAME = 'manual_adopted';

export const MANUAL_ADOPTED_STRATEGY_VERSION = 0;

// M6 W4b (ADR 0010 §1a) — foreign-position policy. Dev/test default is
// `adopt_unmanaged` (operator hand-traded positions on testnet must not be
// wiped); live operator should flip to 'flatten' via the runtime setter at
// boot. M9 will surface this as an operator endpoint; W4b ships the setter so
// the boot pipeline (W8) can drive it.
export type ForeignPositionPolicy = 'adopt_unmanaged' | 'flatten';

export const DEFAULT_FOREIGN_POSITION_POLICY: ForeignPositionPolicy = 'adopt_unmanaged';

// ADR 0010 §1c — absorbs rounding-step noise in case-(c) QTY_MISMATCH
// classification. `qty_tolerance_steps = 1` step in the brief; using a tiny
// absolute decimal floor here is equivalent on USDT-M perp lots and avoids
// needing per-symbol stepSize at classification time.
export const RECONCILIATION_QTY_TOLERANCE: MoneyValue = new Money('0.000000001');

// M49 (ADR 0010 §1b/§1f amendment, H2). `aggregatePnl` sums `tx.fee` into USDT
// `realized_pnl` with no currency check; a fee paid in BNB ("Pay fees with BNB")
// would corrupt USDT PnL by a unit mismatch. Reconciled closing fills therefore only
// count fees denominated in this asset; any other currency is recorded as zero-for-PnL
// and WARN-flagged (BNB→USDT normalization is a separate cross-milestone gap).
export const RECONCILED_FILL_FEE_CURRENCY = 'USDT';

// M49 (M2). Material-divergence thresholds for the realized-PnL integrity probe:
// the locally computed fill cashflow is compared against Binance's own per-trade
// `realizedPnl`. A WARN fires above either bound; the stored value stays the
// ledger-derived aggregate (ADR 0012 §5) — the probe never changes it.
export const RECONCILED_PNL_DIVERGENCE_ABS_THRESHOLD = '0.10';

export const RECONCILED_PNL_DIVERGENCE_REL_THRESHOLD = '0.01';

// R2.1 clean-code R2.2. ccxt-normalised terminal statuses for case-(f)
// `fetchOrderByClientId` resolution (ADR-0010 §1f). Set-lookup instead of an
// open-coded disjunction so the membership check is intention-revealing and a
// future addition (e.g., 'failed') is a single-line const edit.
export const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(['closed', 'canceled', 'expired', 'rejected', 'filled']);

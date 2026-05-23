import { CoinTierEnum } from '@bot/shared';

// Risk-gate constants (ADR 0004 §2/§3/§6/§8). All risk lives OUTSIDE the strategy: these
// are operator-level config, NOT strategy_versions.params (ADR 0004 Conflicts #1). No inline
// magic numbers in risk code (conventions §Constants Placement).

// --- sizing (§8) ---

// Fraction of allocated capital risked per trade. Default 1% per the brief. allocatedCapital
// itself comes from AppConfigService (ACCOUNT_CAPITAL_USDT).
export const RISK_PER_TRADE_PCT = 0.01;

// Hard leverage ceiling (overview locked decision; brief: max 3x).
export const MAX_LEVERAGE = 3;

// --- reservation ledger (§3) ---

// How long a PENDING reservation is held before it is eligible for the M6 TTL sweep. A
// reservation is transient (approval -> fill, seconds); this bounds a phantom hold.
export const RESERVATION_TTL_MS = 60_000;

// --- loss windows (§5) ---
//
// BACKTEST-SEED DEFAULTS ONLY: the consts below (DAILY/WEEKLY loss limits, COOLDOWN, the
// per-coin + same-direction exposure caps) are NOT read by the live gate — the live source is
// AppConfigService (env), threaded into IRiskGateContext.limits. They exist so a backtest that
// constructs the gate without an env can seed the same numbers. Keep them in sync conceptually,
// but the env value wins live.

// Daily realized-PnL loss limit in USDT (positive magnitude; breached when realizedPnlDay <=
// -DAILY_LOSS_LIMIT_USDT).
export const DAILY_LOSS_LIMIT_USDT = 50;

// Rolling 7-day realized-PnL loss limit in USDT (breached when the 7-day sum <= -limit).
export const WEEKLY_LOSS_LIMIT_USDT = 150;

// Rolling weekly window length in days. The lookback lower bound is today-(WEEKLY_LOSS_WINDOW_DAYS-1),
// i.e. an inclusive 7-day window [today-6d, today].
export const WEEKLY_LOSS_WINDOW_DAYS = 7;

// Consecutive closed-loss halt count per UTC day (default 2 for restricted live). Mirrors
// params.consecutive_loss_halt but stays operator config so the gate never depends on the
// strategy for a risk threshold.
export const CONSECUTIVE_LOSS_HALT_COUNT = 2;

// --- cooldown (§ cooldown) ---

// Post-loss re-entry suppression window per symbol (backtest-seed default; live = env).
export const COOLDOWN_AFTER_LOSS_MS = 15 * 60 * 1000;

// --- exposure caps (§3/§ overtrading) ---

// Max USDT notional exposure per coin (backtest-seed default; live = env).
export const MAX_EXPOSURE_PER_COIN_USDT = 250;

// Max combined same-direction (long OR short) portfolio notional in USDT (backtest-seed default; live = env).
export const MAX_SAME_DIRECTION_EXPOSURE_USDT = 600;

// --- slot model (§4) ---

// Idiosyncratic-eligible slots; at most 2 concurrent A/B positions.
export const MAX_IDIOSYNCRATIC_SLOTS = 2;

// At most 1 BTC-correlated position (slot C).
export const MAX_BTC_CORRELATED_POSITIONS = 1;

// --- tier spread ceilings (§ liquidity, brief) ---

// Max bid/ask spread (pct) by coin tier; above it the entry is rejected SPREAD_TOO_WIDE.
export const TIER_SPREAD_CEILING_PCT: Record<CoinTierEnum, number> = {
    [CoinTierEnum.TIER_1]: 0.15,
    [CoinTierEnum.TIER_2]: 0.3,
    [CoinTierEnum.TIER_3]: 0.5,
};

// --- funding filter (§8/§ funding) ---

// Halve notional when funding is unfavourable and at/over the suppress threshold.
export const FUNDING_SIZE_CUT_FACTOR = 0.5;

// Annualized funding above this pct suppresses the entry entirely (FUNDING_SUPPRESSED).
export const FUNDING_ANNUALIZED_SUPPRESS_PCT = 30;

// agg_trade_buy_volume_ratio balance point: above it buyers dominate (a rising-price proxy
// for the short-squeeze funding-skip rule, ADR 0004 §6 / brief line 52).
export const AGG_TRADE_BUY_FLOW_BALANCE = 0.5;

// --- global market-stress halt (§6) ---

// OI shock (abs 5m pct), funding extreme (abs annualized pct), spread widening (pct), and
// depth collapse (USDT) limits that trip the stress halt. The BTC 1m + breadth + same-bar
// thresholds come from the strategy params (stress_* keys) per ADR 0004 §6.
export const STRESS_OI_CHANGE_5M_PCT = 5;
export const STRESS_FUNDING_ANNUALIZED_PCT = 50;
export const STRESS_SPREAD_PCT = 0.6;
export const STRESS_BOOK_DEPTH_FLOOR_USDT = 20_000;

// market_breadth_5m_up_pct neutral midpoint: 50% up = balanced breadth. Stress trips when the
// distance from this midpoint reaches stress_breadth_pct (collapse OR surge).
export const MARKET_BREADTH_NEUTRAL_PCT = 50;

// ETH index shock threshold on the 5m horizon. The snapshot only carries eth_5m_move_pct (a
// 5m field), while strategy params only define a 1m ETH threshold (stress_eth_1m_shock_pct).
// Comparing a 5m move against a 1m bound is a horizon mismatch, so the gate uses this
// engine-side 5m threshold (risk config lives engine-side, ADR 0004 Conflicts #1) rather
// than churning the shared strategy-params schema. BTC stays params-driven on its 1m field.
export const STRESS_ETH_5M_SHOCK_PCT = 2.0;

// --- model-divergence kill switch (§14, M9-fed) ---

// Realized-vs-modeled slippage divergence ratio that trips the halt (realized > modeled x
// this factor). And the absolute win-rate drop (fraction) from paper expectation that trips it.
export const MODEL_DIVERGENCE_SLIPPAGE_RATIO = 2;
export const MODEL_DIVERGENCE_WIN_RATE_DROP = 0.25;

// --- SL-inside-liquidation validation (§8) ---

// Maintenance-margin-style safety buffer (fraction of the liquidation distance) the stop
// must sit inside, leaving room for worst-case adverse move + funding drag. The stop is
// considered safe when its distance from entry is <= (liquidationDistance x this factor).
export const LIQUIDATION_SAFETY_BUFFER_FACTOR = 0.8;

// Conservative default maintenance-margin rate (fraction of notional) used when the
// instrument metadata does not carry a per-symbol Binance maintenance-margin tier. Binance
// USDT-M tiers start around 0.4%; 0.5% is a deliberately conservative single-tier proxy that
// over-estimates the maintenance requirement (pulls the liquidation price CLOSER to entry),
// so the SL-inside-liquidation guarantee never under-protects. The liquidation distance is
// entryPrice x (1/leverage - maintenanceMarginRate); a higher rate => smaller safe distance.
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;

// --- isolated margin default (§13) ---

// Live defaults to isolated margin unless a documented reason selects cross.
export const DEFAULT_MARGIN_MODE_ISOLATED = true;

// --- tier-3 validated-version allow-list (ADR 0004 Conflicts #4) ---

// strategy_versions.id values validated for tier-3 LIVE trading. Empty by default => every
// tier-3 live entry is rejected TIER3_NOT_VALIDATED. Engine config, not a DB column.
export const TIER3_VALIDATED_VERSION_IDS: readonly number[] = [];

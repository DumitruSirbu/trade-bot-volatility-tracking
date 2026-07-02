import { CoinTierEnum } from '@bot/shared';

import { Money } from '../../common/utils/money';

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

// Architectural max concurrent open positions = the 3 slots A/B/C (ADR 0004 §4, locked). NOT a
// tunable knob — widening it is a correlation-budget redesign (new ADR), not a parameter change
// (M34: ≥95% of portfolio variance is undiversifiable at N ≥ 3 under ρ ≈ 0.8). Used by the M34
// reconciliation slot-accounting invariant check (distinct occupied slots must stay ≤ this).
export const MAX_OPEN_POSITIONS = 3;

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

// Per-coin tier-keyed 10bps book-depth floor (USDT) — M22 book-consumption-ratio anchor.
// Depth <= floor => coin_book_too_thin, a per-coin eligibility skip (NOT a halt) inside the
// per-coin tier-filter group (ADR 0004 §6a, M22 amendment). Floor chosen so a max-size order
// (up to MAX_EXPOSURE_PER_COIN_USDT) consumes a small, bounded fraction of the one-sided
// resting 10bps book. All ratios are one-sided (book_depth_10bps_usdt is one-sided notional):
//   tier1 $10k → 2.5% consumption (non-binding for real BTC/ETH; filters volume-mis-ranked impostors)
//   tier2 $2.5k → 10% consumption (~2 bps entry slippage; corrects M19's tier2=tier1 incoherence)
//   tier3 $2k  → 12.5% consumption (~2.5 bps entry; guards exit-gap risk that $1k would not)
// Soak evidence (2026-06-04, 10 rejects): 7 unblocked at $3,468–$9,174; 3 still blocked at
// $529/$681/$2,321. One calm day proves M19 floors overcautious; 14-day post-deploy slippage
// telemetry re-calibrates before any scale-up (see ADR 0004 §6a). Boundary is <= (depth at
// the floor rejects); fail-closed (unknown tier / missing / unparseable → too-thin → reject).
export const COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
    [CoinTierEnum.TIER_1]: 10_000,
    [CoinTierEnum.TIER_2]: 2_500,
    [CoinTierEnum.TIER_3]: 2_000,
};

// --- M51 paper-only per-coin liquidity relax (ADR 0042 §9) ---
//
// Relaxed per-coin liquidity floor/ceiling, applied ONLY when EXCHANGE_ENV=paper AND
// PAPER_RELAX_PER_COIN_LIQUIDITY=true (the two-condition gate, resolved once at boot in
// AppConfigService). These are SEPARATE from — and NEVER mutate — COIN_DEPTH_FLOOR_10BPS_USDT /
// TIER_SPREAD_CEILING_PCT above: under the paper profile they are chosen as the floor/ceiling
// INPUT at the check site (isBookTooThin / isSpreadTooWide), exactly the PAPER_RELAX_MARKET_STRESS
// precedent of relaxing an input rather than editing the live const. Live / testnet / backtest read
// the tier-keyed live floors above, byte-identical to pre-M51 (the relax is unreachable off paper).
//
// Relaxed depth floor: > $2,500 one-sided 10bps book. A $500 max-per-coin order is 20% of a $2,500
// book → ~2 bps linear market-impact — a defensible order/book ratio for paper pipeline validation.
// DO NOT lower below $2,500 ($2,000 = 25%, $1,500 = 33% consumption are too aggressive, ADR 0042 §9).
// Same `depth <= floor` reject convention as ADR 0004 §6a: depth AT $2,500 rejects, $2,501 passes.
// (The value coincides with the live tier2 floor but is a DISTINCT constant — a paper tier1 leader
// clears as if it were tier2 without ever touching the tier1 const.)
export const PAPER_RELAX_COIN_DEPTH_FLOOR_10BPS_USDT = 2_500;

// Relaxed spread ceiling: <= 0.30%. Strict `>` ceiling reject convention (isSpreadTooWide): spread
// AT 0.30% passes, 0.31% rejects. Distinct paper-only constant; the live tier ceilings are untouched.
export const PAPER_RELAX_SPREAD_CEILING_PCT = 0.3;

// --- funding filter (§8/§ funding) ---

// Halve notional when funding is unfavourable and at/over the suppress threshold.
export const FUNDING_SIZE_CUT_FACTOR = 0.5;

// Annualized funding above this pct suppresses the entry entirely (FUNDING_SUPPRESSED).
export const FUNDING_ANNUALIZED_SUPPRESS_PCT = 30;

// agg_trade_buy_volume_ratio balance point: above it buyers dominate (a rising-price proxy
// for the short-squeeze funding-skip rule, ADR 0004 §6 / brief line 52).
export const AGG_TRADE_BUY_FLOW_BALANCE = 0.5;

// --- global market-stress halt (§6) ---

// OI shock (abs 5m pct), funding extreme (abs annualized pct), and spread widening (pct)
// limits that trip the stress halt. Book depth is NO LONGER a global stress input (ADR 0004
// §6 M19 amendment) — it is a per-coin eligibility guard (COIN_DEPTH_FLOOR_10BPS_USDT, §6a),
// so a single thin alt can no longer halt the whole market. Spread widening remains the
// market-wide liquidity-shock proxy. The BTC and ETH index-shock thresholds are engine consts
// (STRESS_BTC_5M_SHOCK_PCT, STRESS_ETH_5M_SHOCK_PCT below); the deprecated
// stress_btc_1m_shock_pct / stress_eth_1m_shock_pct strategy params are no longer consumed. The
// breadth-halt distance is STRESS_BREADTH_DISTANCE_PCT below.
export const STRESS_OI_CHANGE_5M_PCT = 5;
export const STRESS_FUNDING_ANNUALIZED_PCT = 50;
export const STRESS_SPREAD_PCT = 0.6;

// Same-bar co-trigger halt count (engine-side, M28, ADR 0004 §6e). The halt ENGAGES when
// snapshot.same_bar_trigger_count >= STRESS_SAME_BAR_HALT_COUNT. INTENTIONALLY DECOUPLED from
// the `stress_same_bar_trigger_count` strategy param (=5) that `classifyFlowType` consumes to
// route MARKET_BETA flow — do NOT re-couple them: the param stays at 5 for flow classification
// while the halt threshold lives here. At the old param value of 5, a 5% co-trigger rate across
// ~100 symbols halted the entire UTC day — routine crypto-session behaviour, not a cascade.
// Calibrated to soak evidence: routine ceiling 12 (Jun 6), cascade peak 52 (Jun 7).
export const STRESS_SAME_BAR_HALT_COUNT = 20;

// Same-bar resume inner-band ceiling (M28, ADR 0004 §6e). A clean resume tick is
// same_bar_trigger_count < STRESS_SAME_BAR_RESUME_COUNT. Intentionally below the engage count
// (20) so the gap (12 → 20) is the hysteresis buffer that stops the gate chattering at the
// engage boundary, mirroring the breadth resume band.
export const STRESS_SAME_BAR_RESUME_COUNT = 12;

// Consecutive clean same-bar ticks required before a same_bar market_stress halt auto-resumes
// (M28, ADR 0004 §6e). 2 (vs breadth's 3) — a same-bar co-trigger spike is a single-bar
// transient, so a shorter clean window is appropriate. Same in-memory tick-counter lifecycle
// as MARKET_STRESS_RESUME_CLEAR_TICKS (resets on any non-clean tick, NaN fail-closed, recurrence,
// or restart; resets at UTC rollover).
export const SAME_BAR_RESUME_CLEAR_TICKS = 2;

// market_breadth_5m_up_pct neutral midpoint: 50% up = balanced breadth. The breadth halt trips
// when the distance from this midpoint reaches STRESS_BREADTH_DISTANCE_PCT (collapse OR surge).
export const MARKET_BREADTH_NEUTRAL_PCT = 50;

// Breadth-halt distance from neutral (risk-only). The halt fires when
// |market_breadth_5m_up_pct - 50| >= 40, i.e. breadth <= 10 (extreme selloff) or >= 90 (extreme
// melt-up). Raised from 30 to 40 after soak data showed altcoin futures routinely reach 80-89%
// breadth (18-21 bars/day) — the 80% line was treating normal correlated moves as a panic.
// INTENTIONALLY DISTINCT from the `stress_breadth_pct` strategy param (=70) that
// `classifyFlowType` consumes to route MARKET_BETA flow (ADR 0004 §6b) — do NOT re-couple
// them: re-seeding the param to fix the halt would silently change flow classification. The
// halt reads this const; flow classification reads the param; neither sees the other.
export const STRESS_BREADTH_DISTANCE_PCT = 40;

// BTC and ETH index-shock legs both run on the 5m horizon (ADR 0004 §6c, M21, 2026-06-04). The
// snapshot carries btc_5m_move_pct and eth_5m_move_pct (both 5m fields); comparing them against
// engine-side 5m thresholds removes the prior horizon mismatch (a 5m move vs a 1m param bound).
// Risk config lives engine-side (ADR 0004 Conflicts #1), so these stay consts rather than
// churning the shared strategy-params schema.
//
// STRESS_BTC_5M_SHOCK_PCT — calibrated: soak peak btc_5m_move_pct was 1.04%; 1.5% gives real
// buffer. The old BTC 1m leg (stress_btc_1m_shock_pct strategy param) never fired in the 5-day
// soak (peak 0.56% vs 1.0% floor) — empirically inert; switching to the 5m field activates a
// previously dead sensor.
export const STRESS_BTC_5M_SHOCK_PCT = 1.5;

// STRESS_ETH_5M_SHOCK_PCT — raised 2.0 -> 2.5: the only observed near-event was 2.12% (single
// occurrence); 2.5% lifts the gate above that false positive. Per ETH beta (~1.2-1.5x BTC), the
// beta-consistent floor is ~1.8-2.25%, so 2.5% is slightly conservative — appropriate for a
// full UTC-day halt penalty.
export const STRESS_ETH_5M_SHOCK_PCT = 2.5;

// --- market-stress halt-leg suffix tokens (M23, §6d) ---
// Used by StressHaltEvaluator.classifyHaltLeg and the RiskGateService resume branch.
// These are the canonical values written to risk_state.halt_reason after 'market_stress:'.
export const HALT_LEG_INVALID = 'invalid';
export const HALT_LEG_BTC_SHOCK = 'btc_shock';
export const HALT_LEG_ETH_SHOCK = 'eth_shock';
export const HALT_LEG_BREADTH = 'breadth';
export const HALT_LEG_SAME_BAR = 'same_bar';
export const HALT_LEG_OI = 'oi';
export const HALT_LEG_FUNDING = 'funding';
export const HALT_LEG_SPREAD = 'spread';
export const HALT_LEG_MULTI = 'multi';
// Market-stress halt legs eligible for adaptive auto-resume (M23 breadth + M28 same_bar). Every
// other leg (BTC/ETH shock, OI, funding, spread, multi, invalid) and every loss-based reason
// stays full-day locked. Consumed by RiskGateService.isStressLegAutoResumeEligible and the
// RiskListeners leg check.
export const MARKET_STRESS_RESUME_ELIGIBLE_LEGS: ReadonlySet<string> = new Set([HALT_LEG_BREADTH, HALT_LEG_SAME_BAR]);

// --- market-stress adaptive resume (§6d, M23) ---

// Consecutive clean global-breadth decision ticks (breadth in the inner hysteresis band)
// required before a breadth-triggered market_stress halt auto-resumes. Default 3 — a STARTING
// POINT pending a proper per-bar consecutive-clean-bar analysis with held-out validation, NOT a
// validated calibration (the original N=3 was sampled at fixed +5/+10/+15m offsets on a 6-day,
// single-regime, zero-out-of-sample dataset, not from the full per-bar series). The counter is
// in-memory on RiskGateService, advances once per gate evaluation (ticks, not minutes — a
// determinism choice), and resets to 0 on any non-clean tick, NaN fail-closed, recurrence, or
// restart. Operators tune this against the post-deploy paper soak (ADR 0004 §6d).
export const MARKET_STRESS_RESUME_CLEAR_TICKS = 3;

// Inner hysteresis band for resume. The halt ENGAGES at |breadth - 50| >= STRESS_BREADTH_DISTANCE_PCT
// (40, i.e. breadth <= 10 or >= 90). Resume requires breadth to re-enter |breadth - 50| <= 30
// (breadth in [20, 80]). The 10-point gap on each side is the hysteresis buffer that stops the
// gate chattering at the engage boundary — a reading in (10, 20) or (80, 90) is below the engage
// threshold but does NOT count toward resume (it resets the clean-tick counter). The resume
// predicate uses strict `>` at this distance (still-stressed when |breadth - 50| > 30); engage
// uses `>=` at 40 (ADR 0004 §6d). Reuses the old M19 engage value pending per-bar autocorrelation
// validation after a 30-60 day soak (logged as tech-debt).
export const MARKET_STRESS_RESUME_BREADTH_DISTANCE = 30;

// Per-UTC-day cap on breadth market_stress re-halts. On the 3rd breadth re-halt in one UTC day the
// gate falls back to the FULL-DAY LOCK (auto-resume disabled for the rest of the day; the halt
// persists to rollover exactly like a loss halt). Chatter is itself a regime signal — a market
// oscillating between collapse and surge is exactly when the conservative day-lock should reassert.
// The counter is in-memory and resets at UTC rollover (same lifecycle as stressEmittedForDate).
export const MARKET_STRESS_MAX_DAILY_REHALT = 3;

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

// --- cost-aware exit-geometry guard (M35 Finding 3) ---

export const RISK_TAKER_FEE_RATE = new Money('0.0004');

// --- R:R backstop (ADR 0004) ---

// Loose backstop — cores are the binding constraint (min_rr=1.5 in version params). Gate
// only catches pathological edge cases that slip past the cores (e.g. post-clamp geometry
// inversion). Intentionally loose; a gate at 1.5 would be a kill-switch rejecting 92% of
// historical signals.
export const MIN_RR_GATE_FLOOR = new Money('1.0');

// --- isolated margin default (§13) ---

// Live defaults to isolated margin unless a documented reason selects cross.
export const DEFAULT_MARGIN_MODE_ISOLATED = true;

// --- tier-3 validated-version allow-list (ADR 0004 Conflicts #4) ---

// strategy_versions.id values validated for tier-3 LIVE trading. Empty by default => every
// tier-3 live entry is rejected TIER3_NOT_VALIDATED. Engine config, not a DB column.
export const TIER3_VALIDATED_VERSION_IDS: readonly number[] = [];

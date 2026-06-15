// Strategy-engine constants (ADR 0003 §2). No inline magic numbers in strategy code.

// Deterministic clock base. nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS (the
// close time of the trigger bar). Reuses the market-data 5m interval — the canonical bar
// length — rather than redefining it, so the two never drift.
export { CANDLE_5M_INTERVAL_MS as CANDLE_INTERVAL_MS } from '../../market-data/const/candleConsts';

// Config key selecting the active strategy_versions.id (read via AppConfigService). Value
// comes from env; switching the active version is a config change + restart, no code change.
export const ACTIVE_STRATEGY_VERSION_ID_ENV = 'ACTIVE_STRATEGY_VERSION_ID';

// Number of milliseconds in one minute, for the time-stop target arithmetic.
export const MS_PER_MINUTE = 60_000;

// --- v1 mean-reversion exhaustion-confirmation tolerances (ADR 0003 §4, M3 brief) ---

// Take-profit target is VWAP pulled in by this many sigma for conservatism: TP sits at
// VWAP ± TAKE_PROFIT_VWAP_SIGMA_OFFSET × the deviation band (closer than full VWAP).
export const TAKE_PROFIT_VWAP_SIGMA_OFFSET = 0.5;

// Strict Bollinger %B re-entry thresholds for the "close back inside the band" exhaustion
// confirmation. %B is (close - lowerBand) / (upperBand - lowerBand): 1.0 at the upper band,
// 0.0 at the lower band, 0.5 at the basis. A fresh, still-extended spike closes pinned at
// or beyond its band edge (%B >= 1.0 on a pump, <= 0.0 on a dump). Requiring the close to
// have retreated a full 20% of the band width back INSIDE distinguishes a rejected wick
// (exhaustion) from a bar still riding the band — so 1.0 / 0.0 would be a no-op (the whole
// band is [0,1]) and is rejected. A pump confirms only when %B < UPPER, a dump when
// %B > LOWER.
export const BAND_REENTRY_UPPER_PCT_B = 0.8;
export const BAND_REENTRY_LOWER_PCT_B = 0.2;

// Volume deceleration: current bar volume_ratio at or below this fraction of the spike
// trigger floor signals the impulse is fading (exhaustion confirmation).
export const VOLUME_DECELERATION_RATIO = 1.0;

// Open-interest "stopped rising / started falling" tolerance (pct over the 5m window).
// At or below this, OI is no longer building the move — an exhaustion confirmation.
export const OI_NOT_RISING_THRESHOLD_PCT = 0.0;

// v1 idiosyncratic-decoupling scope guard (ADR 0003 §4 trap). When idiosyncrasy is at or
// above idiosyncrasy_min_score AND OI is rising AND volume is elevated, v1 refuses to fade.
export const OI_RISING_THRESHOLD_PCT = 0.0;

// --- v2 momentum exit (M3 brief: TP = entry ± atr14 × 2.0, wider than reversion) ---
export const MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0;

// Machine-readable entry-thesis reason codes stamped on an OPEN signal's reason field
// (skips use the SkipReasonEnum value instead). Queryable in M8 alongside skip reasons.
export const REASON_MEAN_REVERSION_FADE = 'mean_reversion_exhaustion_fade';
export const REASON_MOMENTUM_FOLLOW = 'momentum_follow';

// --- M11a W0.6.1 — VirtualPositionLedgerService (ADR 0029 §2.1) ---

// Consecutive-loss threshold the virtual ledger uses to arm its own
// `haltedUntilRiskDayUtcDate` flag at the moment the streak is observed.
// Mirrors the M11a §W4.1 restricted profile (`halt_after_consecutive_losses: 2`).
// `VirtualPositionLedgerService.evaluateGates` independently honours the
// per-call `haltAfterConsecutiveLosses` from `IVirtualGateInput` so a future
// profile change is a caller-side update; this constant is the ledger's own
// internal arming threshold for the durable halt flag.
export const VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD = 2;

// An unreachable streak count threads the relax through the existing numeric
// threshold rather than adding a new boolean relax-mode parameter to the gate
// and arm surfaces (M36, D3/D4).
export const SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL = Number.MAX_SAFE_INTEGER;

// --- M11a W2 — ShadowStrategyOrchestratorService (ADR 0029 §2.2) ---

// Discriminator prefix for the `shadow_decisions.shadow_version` text column.
// Combined with `StrategyVersionEntity.version` to produce values like 'v0',
// 'v2', 'v3'. The discriminator is purely shadow-row metadata — the registry
// keys on `(name, version)`, not this string.
export const SHADOW_VERSION_DISCRIMINATOR_PREFIX = 'v';

// Restricted-profile gates the shadow orchestrator presents to every shadow
// version's `evaluateGates` (mirrors live restricted profile, ADR 0029 §2.1).
// Held here rather than in the ledger so a future profile change is a single-
// site config update; the ledger itself is profile-agnostic.
export const SHADOW_GATE_MAX_OPEN_POSITIONS = 1;
export const SHADOW_GATE_MAX_TRADES_PER_DAY = 3;
export const SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES = 2;
export const SHADOW_GATE_REQUIRE_EXHAUSTION_CONFIRMATION = true;
export const SHADOW_GATE_SKIP_MARKET_STRESS = true;
export const SHADOW_GATE_MARGIN_MODE: 'isolated' | 'cross' = 'isolated';

// Latency floor (ms) the shadow path passes to HistoricalFillAdapter. Mirrors
// the M8 compare CLI value (`DEFAULT_LATENCY_MS = 100`) — shadow is the closest
// kin to a same-tape replay, not the M7 historical 250ms latency.
export const SHADOW_FILL_LATENCY_MS = 100;

// Order policy used for the simulated entry. Shadow versions never reach the
// live OrderPolicyRouter (no risk gate context, no flow-type-aware fee matrix
// for v0/v2/v3 hybrids on this path), so we fix on the marketable-limit IOC
// policy v1 uses for the bulk of its live opens — the conservative choice for
// like-for-like cost accounting (ADR 0029 §2.3).
export const SHADOW_FILL_DEFAULT_POLICY = 'marketable_limit_ioc';

// Binance USDT-M Futures default taker fee (non-VIP retail): 4 bps = 0.04%.
// Mirrors the canonical rate inside the shared fillSimulatorCore (ADR 0015 §6).
// Used by the shadow-close PnL calculation to charge the same per-leg fee the
// live path pays so v1-realised and shadow-simulated PnL series remain
// dimensionally comparable for the ADR 0018 paired bootstrap.
// Held as a decimal-as-string per the project's money-is-Decimal invariant —
// callers wrap in `new Decimal(SHADOW_TAKER_FEE_PCT)` for arithmetic.
export const SHADOW_TAKER_FEE_PCT = '0.0004';

// Default active-positions count stamped onto the market snapshot before the gate
// evaluates; the real count is threaded in post-evaluate via stampGateVerdict.
export const ACTIVE_POSITIONS_COUNT_DEFAULT = 0;

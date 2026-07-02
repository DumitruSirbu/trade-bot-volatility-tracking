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

// Fixed 24h momentum rebalance period (ADR 0050 §4.3). Cadence is pinned to the cron below;
// rebalance_interval_ms in strategy_versions must match for time-stop sizing.
export const MOMENTUM_REBALANCE_PERIOD_MS = 86_400_000;

// Standard 5-field cron: daily at 01:07 UTC (ADR 0050 §4.2 — past funding, before pg_dump).
export const MOMENTUM_REBALANCE_CRON_EXPRESSION = '7 1 * * *';

// Dynamic cron job name registered against SchedulerRegistry by RebalanceSchedulerService
// (registered only under the paper gate; deleted on module destroy).
export const MOMENTUM_REBALANCE_CRON_NAME = 'momentum-rebalance';

// Cooldown window guarding the manual rebalance trigger. The guard is ONE-DIRECTIONAL: a MANUAL
// trigger is rejected when it lands within this window of the last emission (scheduled or manual).
// It prevents a manual trigger from re-firing (or piling onto a just-fired scheduled cron) inside
// the window. It does NOT suppress a scheduled cron tick that lands shortly AFTER a manual trigger —
// that scheduled rebalance still fires, and that is accepted behavior, not a gap: suppressing the
// real 01:07 UTC scheduled rebalance would be worse than an occasional extra rebalance. 5 minutes.
export const REBALANCE_TRIGGER_COOLDOWN_MS = 5 * 60 * 1_000;

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

// --- v2/v3 momentum exit geometry (M3 brief, M43 D2) ---
// Governs the SHORT side only. The LONG side uses the wider, cost-floor-anchored geometry
// below (M43 D2) — its VWAP structural stop sits the full session-deviation distance away,
// so a symmetric 2.0× target left long-side RR at ~0.5 (M43 D2 architect adjudication).
export const MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0;

// --- M43 D2 — long-book reward:risk repair (architect adjudication 2026-06-21) ---

// LONG-side ATR TP multiplier. Distinct from MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER (2.0,
// shorts): 3.5 scales the long TP distance by 1.75×, lifting median tier1 long RR from
// ~0.45 toward ~0.78 without driving median trades into the 15-min time-stop tail.
export const MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER = 3.5;

// Cost-floor-leg safety margin (fraction of entry, 0.10%). The long TP is anchored at
// max(atr×k, costFloor + margin); this margin keeps the floor leg strictly above the
// risk gate's roundTripCostDistance so a floor-anchored long TP never sits at-or-below cost.
export const MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT = 0.001;

// Round-trip taker fee rate (0.04%) used by the long-TP cost-floor anchor.
// Mirrors RISK_TAKER_FEE_RATE in riskConsts — kept here to avoid a strategy→risk import.
// Held as a decimal-as-string per the money-is-Decimal invariant.
// Same value as SHADOW_TAKER_FEE_PCT below (the shadow-close PnL fee leg); the two are kept
// separate because a merge would cascade the rename across 5+ consumer/test files.
export const MOMENTUM_TAKER_FEE_RATE = '0.0004';

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
// Same value as MOMENTUM_TAKER_FEE_RATE above (the long-TP cost-floor anchor); kept separate
// because a merge would cascade the rename across 5+ consumer/test files.
export const SHADOW_TAKER_FEE_PCT = '0.0004';

// Default active-positions count stamped onto the market snapshot before the gate
// evaluates; the real count is threaded in post-evaluate via stampGateVerdict.
export const ACTIVE_POSITIONS_COUNT_DEFAULT = 0;

// Virtual positions older than this during cold-restart ledger rebuild are
// phantom slots — the deferred exit walker never resolved their close. Purged
// at 'force_close' (exempt from consecutive-loss streak) so the slot is freed.
// 24 h is a safe floor: the longest configured time-stop is a few hours.
export const SHADOW_STALE_POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT = 'ticks_absent';
export const SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL = 'evidence_null_despite_ticks';

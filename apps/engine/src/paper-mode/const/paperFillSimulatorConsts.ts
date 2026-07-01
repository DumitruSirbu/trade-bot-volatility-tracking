// Latency model for PAPER live event-time (ADR 0032 §D15). M5 LIVE
// submit-network-timeout is 5s; PAPER simulates a more modest engine-internal
// latency (50ms = "send a JSON document over a Postgres tx, round-trip a
// callback") to keep the soak's expected fill cadence close to LIVE without
// smuggling in network-jitter modelling that PAPER does not measure.
//
// M11a R4 Item 5: relocated from PaperFillSimulator.ts.
export const PAPER_FILL_LATENCY_MS = 50;

// Default coin tier for PAPER R2c.C — the M11a restricted profile pins
// `tier-1 only` and the live `CoinTierClassifier` is not yet wired into the
// PAPER decision loop. Documented choice; matches the restricted profile.
//
// M11a R4 Item 5: relocated from PaperExecutionClient.ts. Imported as a
// CoinTierEnum sentinel string at the call site to avoid the enum dependency
// here.
export const PAPER_DEFAULT_COIN_TIER_LABEL = 'TIER_1';

// PAPER fill ID prefix so a downstream consumer reading the ledger / the
// IOrder.exchangeOrderId can grep for "paper:" origin without parsing the
// UUID itself.
//
// M11a R4 Item 5: relocated from PaperExecutionClient.ts.
export const PAPER_EXCHANGE_ORDER_ID_PREFIX = 'paper-fill:';

// Stale-tick threshold for StreamingFillAdapter: a tick older than this is
// considered too cold to fill against. Mirrors M5's submit-network-timeout.
export const STREAMING_FILL_STALE_TICK_MS = 5_000;

// Internal adapter missed-reason when StreamingFillAdapter has no usable tick.
// ISimulatedFillCore keeps string reasons; public ISimulatedFill maps to MissedReasonEnum separately.
export const PAPER_MISSED_REASON_NO_TICK_CACHED = 'no_tick_cached';

// D17 — idempotency-ledger version-namespace prefix for the ACTIVE (non-shadow)
// PAPER run. The composite key (eventId, orderIntentId, namespace) uses this to
// keep active-run ledger rows from colliding with the separate `paper.shadow.v<id>`
// namespace, AND to encode which strategy version actually executed the order.
export const PAPER_ACTIVE_VERSION_NAMESPACE_PREFIX = 'paper.active.v';

// D17 / ADR 0049 — fallback version label used ONLY when neither the legacy
// single-symbol version id nor the M50 portfolio version id is set. A literal
// `vnull` (from interpolating a null id) no longer encodes the executing
// version; this explicit sentinel keeps the namespace intention-revealing and
// prevents an accidental `paper.active.vnull` in the dormant-legacy state.
export const PAPER_ACTIVE_VERSION_NAMESPACE_NONE = 'none';

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
